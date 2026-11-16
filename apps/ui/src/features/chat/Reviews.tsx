import { useEffect } from "react";
import { artifactMeta } from "../../lib/format.js";
import type { CanvasRun, CanvasStore } from "./store/types.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";
export function Reviews({
  run,
  connected,
  onLoad,
  onReview,
}: {
  readonly run: CanvasRun;
  readonly connected: boolean;
  readonly onLoad: CanvasStore["loadArtifacts"];
  readonly onReview: CanvasStore["reviewArtifacts"];
}) {
  const review = run.run.review;
  useEffect(() => {
    if (review) void onLoad(run.id);
  }, [run.id, review, onLoad]);
  if (!review) return null;
  const ready =
    connected &&
    !run.reviewBusy &&
    !run.reviewError &&
    review.requests.every((request) => run.artifacts?.some((row) => row.artifactId === request.artifactId));
  const pending =
    run.artifacts?.filter(
      (row) => row.reviewState === "pending" && review.requests.some((request) => request.artifactId === row.artifactId),
    ) ?? [];
  return (
    <section className="review" aria-label="artifact review">
      <h3>Review held files</h3>
      <p>
        Tavi held these files back: the chat reads one only once you approve it, and a rejected one never reaches it. Their content is not
        shown here; <Command>tavi artifacts list</Command>, <code>approve</code> and <code>reject</code> do the same from a terminal.
      </p>
      <ul>
        {review.requests.map((request) => {
          const artifact = run.artifacts?.find((row) => row.artifactId === request.artifactId);
          return (
            <li key={request.artifactId} className="review-item">
              {/* A file by its name, as the person will find it; the id after, for the terminal's commands. */}
              <span className="review-item-what">
                {artifact?.fileName === undefined ? null : <strong>{artifact.fileName}</strong>} <code>{request.artifactId}</code> —{" "}
                {request.toolName}: {artifact ? artifactMeta(artifact) : "metadata unavailable"}
              </span>
              {artifact?.reviewState === "pending" ? (
                <>
                  <Button disabled={!ready} onClick={() => onReview(run.id, [{ artifactId: artifact.artifactId, approved: true }])}>
                    Approve artifact
                  </Button>
                  <Button disabled={!ready} onClick={() => onReview(run.id, [{ artifactId: artifact.artifactId, approved: false }])}>
                    Reject artifact
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {pending.length ? (
        <>
          <Button
            disabled={!ready}
            onClick={() =>
              onReview(
                run.id,
                pending.map((row) => ({ artifactId: row.artifactId, approved: true })),
              )
            }
          >
            Approve all pending
          </Button>
          <Button
            disabled={!ready}
            onClick={() =>
              onReview(
                run.id,
                pending.map((row) => ({ artifactId: row.artifactId, approved: false })),
              )
            }
          >
            Reject all pending
          </Button>
        </>
      ) : (
        <Button
          disabled={!ready}
          onClick={() =>
            onReview(
              run.id,
              (run.artifacts ?? []).map((row) => ({ artifactId: row.artifactId, approved: row.reviewState === "approved" })),
            )
          }
        >
          Continue the chat
        </Button>
      )}
      <Button disabled={run.reviewBusy || !connected} onClick={() => void onLoad(run.id)}>
        Refresh metadata
      </Button>
      {run.reviewBusy ? <p>Recording review…</p> : null}
      {run.reviewError ? <Failure alert={false}>{run.reviewError}</Failure> : null}
    </section>
  );
}
