import { type ArtifactListRow, ArtifactsResultSchema, type ReviewResult } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { refusal } from "../../../lib/ipc.js";
import type { StoreContext } from "./context.js";
import { without } from "./runs.js";
import type { CanvasStore } from "./types.js";

/** An artifact review's metadata and decisions. */
export function installArtifacts(ctx: StoreContext): void {
  const { client, options, artifactLoads } = ctx;
  const loadArtifacts = async (id: string): Promise<void> => {
    const run = ctx.find(id);
    const review = run?.run.review;
    if (!review || !run.run.taskId || run.reviewBusy) return;
    const generation = (artifactLoads.get(id) ?? 0) + 1;
    artifactLoads.set(id, generation);
    try {
      const rows: ArtifactListRow[] = [];
      const ids = review.requests.map((request) => request.artifactId);
      for (let offset = 0; offset < ids.length; offset += 100) {
        const answer = await client.request("artifacts", {
          workspaceId: options.workspaceId,
          taskId: run.run.taskId,
          artifactIds: ids.slice(offset, offset + 100),
          limit: 100,
        });
        if (ctx.disposed || ctx.find(id)?.run.review !== review || artifactLoads.get(id) !== generation) return;
        if (!answer.ok) throw new Error(`${refusal(answer, "Artifact metadata unavailable")}. Restart the owner if it predates this page.`);
        const page = ArtifactsResultSchema.parse(answer.result);
        rows.push(
          ...page.rows.filter(
            (row) => row.workspaceId === options.workspaceId && row.runId === run.run.taskId && ids.includes(row.artifactId),
          ),
        );
      }
      ctx.update(id, (entry) => ({ ...without(entry, "reviewError"), artifacts: rows }));
    } catch (error) {
      if (!ctx.disposed && ctx.find(id)?.run.review === review && artifactLoads.get(id) === generation)
        ctx.update(id, (entry) => ({ ...entry, reviewError: errorMessage(error) }));
    }
  };
  const reviewArtifacts: CanvasStore["reviewArtifacts"] = (id, decisions) => {
    const run = ctx.find(id);
    const review = run?.run.review;
    if (
      !run ||
      !review ||
      !run.run.taskId ||
      run.reviewBusy ||
      run.reviewError ||
      ctx.state.connection !== "ready" ||
      !decisions.length ||
      decisions.length > 384 ||
      new Set(decisions.map((decision) => decision.artifactId)).size !== decisions.length ||
      decisions.some((decision) => !review.requests.some((request) => request.artifactId === decision.artifactId))
    )
      return;
    const artifacts = run.artifacts;
    if (artifacts === undefined || review.requests.some((request) => !artifacts.some((row) => row.artifactId === request.artifactId)))
      return;
    const resume = artifacts
      .filter((row) => review.requests.some((request) => request.artifactId === row.artifactId) && row.reviewState === "pending")
      .every((row) => decisions.some((decision) => decision.artifactId === row.artifactId));
    artifactLoads.set(id, (artifactLoads.get(id) ?? 0) + 1);
    ctx.update(id, (entry) => ({ ...without(entry, "reviewError"), reviewBusy: true }));
    client
      .request("review", {
        taskId: run.run.taskId,
        workspaceId: options.workspaceId,
        decisions,
        reviewedBy: options.principal,
        resume,
        ...(resume ? { expectedSteps: review.steps } : {}),
      })
      .then((answer) => {
        if (ctx.disposed || ctx.find(id)?.run.review !== review) return;
        if (!answer.ok)
          throw new Error(`${refusal(answer, "Review refused")}. Refresh metadata before retrying if the decision may have been recorded.`);
        const result = answer.result as ReviewResult;
        ctx.update(id, (entry) => ({
          ...entry,
          reviewBusy: false,
          artifacts:
            entry.artifacts?.map((row) => ({
              ...row,
              reviewState: result.decisions.find((decision) => decision.artifactId === row.artifactId)?.reviewState ?? row.reviewState,
            })) ?? [],
        }));
      })
      .catch((error: unknown) => {
        if (!ctx.disposed && ctx.find(id)?.run.review === review)
          ctx.update(id, (entry) => ({ ...entry, reviewBusy: false, reviewError: errorMessage(error) }));
      });
  };
  Object.assign(ctx, { loadArtifacts, reviewArtifacts } satisfies Partial<StoreContext>);
}
