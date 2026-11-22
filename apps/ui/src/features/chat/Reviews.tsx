import { useEffect } from "react";
import { artifactMeta } from "../../lib/format.js";
import type { CanvasRun, CanvasStore } from "./store/types.js";
import { spoken } from "./store/said.js";
import { useT } from "../../lib/i18n.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../welcome/WelcomeStepParts.js";
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
  const t = useT();
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
    <section className="review" aria-label={t("chat.review.label")}>
      <h3>{t("chat.review.heading")}</h3>
      <p>
        {withParts(t("chat.review.intro"), {
          list: <Command>tavi artifacts list</Command>,
          approve: <code>approve</code>,
          reject: <code>reject</code>,
        })}
      </p>
      <ul>
        {review.requests.map((request) => {
          const artifact = run.artifacts?.find((row) => row.artifactId === request.artifactId);
          return (
            <li key={request.artifactId} className="review-item">
              {/* A file by its name, as the person will find it; the id after, for the terminal's commands. */}
              <span className="review-item-what">
                {artifact?.fileName === undefined ? null : <strong>{artifact.fileName}</strong>} <code>{request.artifactId}</code> —{" "}
                {request.toolName}: {artifact ? artifactMeta(artifact) : t("chat.review.noMeta")}
              </span>
              {artifact?.reviewState === "pending" ? (
                <>
                  <Button disabled={!ready} onClick={() => onReview(run.id, [{ artifactId: artifact.artifactId, approved: true }])}>
                    {t("chat.review.approve")}
                  </Button>
                  <Button disabled={!ready} onClick={() => onReview(run.id, [{ artifactId: artifact.artifactId, approved: false }])}>
                    {t("chat.review.reject")}
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
            {t("chat.review.approveAll")}
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
            {t("chat.review.rejectAll")}
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
          {t("chat.review.continue")}
        </Button>
      )}
      <Button disabled={run.reviewBusy || !connected} onClick={() => void onLoad(run.id)}>
        {t("chat.review.refresh")}
      </Button>
      {run.reviewBusy ? <p>{t("chat.review.recording")}</p> : null}
      {run.reviewError ? <Failure alert={false}>{spoken(run.reviewError, t)}</Failure> : null}
    </section>
  );
}
