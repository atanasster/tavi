import { interrupt } from "@langchain/langgraph";
import {
  TaviError,
  type WorkflowMessage,
  type WorkflowReviewInterrupt,
  type WorkflowReviewRequest,
  parseAgentState,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { assertLeaseCurrent } from "../run-config.js";
import type { WorkflowScope } from "../scope.js";
import type { WorkflowUpdate, WorkflowNode } from "../state.js";

/** The review node: suspends a turn while an artifact a tool produced waits for a person's review. */
export function createReviewNode(scope: WorkflowScope): WorkflowNode {
  const { options } = scope;
  /**
   * Suspend the turn until every artifact this turn's tool results flagged
   * `pendingReviewArtifactIds` on has a terminal review decision.
   * A sibling of `approveNode`, not a variant of it:
   * approval decides whether a call may run, before it runs; this decides
   * whether an already-produced result may be trusted, after it already
   * ran.
   *
   * **Why this can't live inside `toolsNode`'s own per-call loop**:
   * `toolsNode` dispatches calls sequentially inside one node invocation,
   * and only writes `conversation` once, at the very end. Suspending
   * mid-loop — after call A already produced a real, ledgered effect, but
   * before call B in the same batch has even been dispatched — would mean
   * a resumed replay of `toolsNode` restarting from the top has to
   * re-dispatch A too; that's only safe if A's effect is idempotent
   * (mutating/external calls are, via the effect ledger — but a read-only
   * call in the same batch is not ledgered at all, so replaying it would
   * silently re-execute it for real). Making this a **separate node**
   * after `toolsNode` sidesteps the problem entirely: every call in the
   * batch has already dispatched and its `conversation` messages are
   * already durably merged into checkpointed state by the time this node
   * ever runs, so there is nothing partially-done to replay unsafely.
   *
   * **Why the durable state lives on the artifact record, not a parallel
   * ledger** (mirroring `agents.wait`'s "durable row is the truth, the
   * resume value is only a nudge" discipline, not `approveNode`'s
   * "durable-request-then-decide" shape): this node restarts from the top
   * on every resume, same as every other interrupting node — so on each
   * pass it re-scans `current.conversation` for flagged messages and
   * re-reads each flagged artifact's *current* `reviewState` live via
   * `options.artifacts`. A still-`pending` artifact means `interrupt()`
   * fires again (with a possibly-smaller `requests` list, if some of this
   * turn's flagged artifacts were already decided); once every flagged
   * artifact for this turn has a terminal state, the node falls through
   * to build its return value and `interrupt()` is never reached again —
   * exactly the same "durable check short-circuits before ever reaching
   * `interrupt()` again" pattern `waitFor` already established. The
   * `reply` value `interrupt()` returns on a resumed pass is therefore
   * never read for its content — `WorkflowResumeDecision.reviewAck` is
   * documented as exactly that, a wake-up signal only.
   *
   * **Rejected artifacts never reach the model.** For any flagged message
   * where at least one referenced artifact was rejected (a mixed
   * approved/rejected message is treated as rejected in full — the
   * safer default), this node returns a REPLACEMENT `WorkflowMessage`
   * with the identical `id`: `mergeConversation`'s merge-by-id semantics
   * (this file, above) mean the replacement silently supersedes the
   * original in the `conversation` channel the model actually reads from
   * — the real content is never removed from the artifact store (an
   * operator can still inspect why something was rejected), only from
   * what the model sees.
   */
  const reviewNode: WorkflowNode = async (state, config): Promise<WorkflowUpdate> => {
    const current = parseAgentState(state);
    await assertLeaseCurrent(options, config);
    if (options.artifacts === undefined) return {};
    const artifacts = options.artifacts;

    const flagged = current.conversation.filter(
      (message) => message.role === "tool" && (message.pendingReviewArtifactIds?.length ?? 0) > 0,
    );
    if (flagged.length === 0) return {};

    /** Re-derived fresh every time it's called — live artifact state, never cached across an `interrupt()` boundary. */
    async function classify(): Promise<{
      readonly stillPending: readonly { readonly message: WorkflowMessage; readonly artifactIds: readonly string[] }[];
      readonly replacements: WorkflowMessage[];
    }> {
      const stillPending: { readonly message: WorkflowMessage; readonly artifactIds: readonly string[] }[] = [];
      const replacements: WorkflowMessage[] = [];
      for (const message of flagged) {
        const ids = message.pendingReviewArtifactIds ?? [];
        // A missing record (`getArtifact` returns `undefined` — deleted,
        // evicted, or never actually written) is treated the same as
        // `"pending"`: the fail-safe default is to never let unknown
        // content through. A known limitation:
        // there is deliberately no operator-facing way to force a
        // decision on a permanently-missing artifact — if that record can
        // never come back, this message (and the admission waiting on it)
        // stays suspended indefinitely. Re-review or revocation of an
        // already-approved artifact is out of scope too, and a recovery path for a
        // genuinely lost record is the same kind of unneeded scaffolding.
        // One read per artifact: its state and its reviewer's note come from the same record.
        const states = await Promise.all(
          ids.map(async (artifactId) => {
            const record = await artifacts.getArtifact(artifactId);
            return { artifactId, reviewState: record?.reviewState, reviewNote: record?.reviewNote };
          }),
        );
        const pendingIds = states
          .filter((entry) => entry.reviewState === undefined || entry.reviewState === "pending")
          .map((entry) => entry.artifactId);
        if (pendingIds.length > 0) {
          stillPending.push({ message, artifactIds: pendingIds });
          continue;
        }
        if (states.some((entry) => entry.reviewState === "rejected")) {
          const rejected = states.filter((entry) => entry.reviewState === "rejected");
          const rejectedIds = rejected.map((entry) => entry.artifactId);
          // The reviewer's own words, when they gave any: what the
          // model reads instead of the content, as an approval denial's note is.
          const reviewerNotes = Object.fromEntries(
            rejected.flatMap((entry) =>
              entry.reviewNote === undefined || entry.reviewNote.trim() === "" ? [] : [[entry.artifactId, entry.reviewNote] as const],
            ),
          );
          const said = Object.entries(reviewerNotes).map(([artifactId, note]) =>
            rejectedIds.length > 1 ? `${artifactId}: ${note}` : note,
          );
          replacements.push({
            ...message,
            output: {
              status: "rejected_by_review",
              note:
                `Artifact review rejected this result (artifact${rejectedIds.length > 1 ? "s" : ""} ${rejectedIds.join(", ")}); the original content was not delivered.` +
                (said.length === 0 ? "" : ` The reviewer said: ${said.join("; ")}`),
              rejectedArtifactIds: rejectedIds,
              ...(said.length === 0 ? {} : { reviewerNotes }),
            },
            isError: true,
            pendingReviewArtifactIds: undefined,
          });
          continue;
        }
        // Every referenced artifact is `approved`: the original message
        // already carries the real content, so only the now-stale flag is
        // cleared (mirroring the rejected branch above) — otherwise this
        // message would be re-scanned and re-fetched from the artifact
        // repository on every later turn for the rest of the admission,
        // purely wasted work once its review is fully resolved.
        replacements.push({ ...message, pendingReviewArtifactIds: undefined });
      }
      return { stillPending, replacements };
    }

    // A cancelled task never presents a review prompt: cancellation is authoritative.
    const cancellation = await options.cancellations.get(current.runId);
    if (cancellation !== undefined) {
      return {
        phase: "failed" as const,
        finalText: `Task was cancelled by ${cancellation.requestedBy}: ${cancellation.reason}`,
      };
    }

    // `interrupt()` resolves at most one resume value per admit() call — an
    // operator who resumes before every flagged artifact is decided leaves
    // `stillPending` non-empty even after `interrupt()` returns, so this
    // loops rather than assuming one resume fully resolves everything.
    // Each iteration re-derives state fresh; a genuinely unresolved
    // `interrupt()` call throws (suspends) exactly as it does everywhere
    // else in this file, so this never spins — it either returns or
    // suspends within two iterations.
    for (;;) {
      const { stillPending, replacements } = await classify();
      if (stillPending.length === 0) {
        return replacements.length === 0 ? {} : { conversation: replacements };
      }
      // Deduped by artifact id: the same artifact could in principle be
      // referenced from more than one flagged message, and this keeps the
      // interrupt payload — and its exposure to `MAX_REVIEW_REQUESTS` —
      // proportional to distinct artifacts, not to messages.
      const seenArtifactIds = new Set<string>();
      const requests: WorkflowReviewRequest[] = [];
      for (const entry of stillPending) {
        // `flagged` (above) is already filtered to `role: "tool"`
        // messages, and every producer of `pendingReviewArtifactIds`
        // (`dispatchTool`/`runHandler`) always sets `toolCallId`/
        // `toolName` on that role — an internal invariant, not
        // caller input, so a violation is a real bug in this file, not
        // a case to paper over with `?? ""` (which would otherwise
        // silently build a payload `WorkflowReviewRequestSchema` — and
        // therefore every caller reading `reviewInterrupt` — rejects).
        if (entry.message.toolCallId === undefined || entry.message.toolName === undefined) {
          throw new TaviError("INTERNAL", `Artifact-review-flagged message ${entry.message.id} is missing toolCallId/toolName`);
        }
        for (const artifactId of entry.artifactIds) {
          if (seenArtifactIds.has(artifactId)) continue;
          seenArtifactIds.add(artifactId);
          requests.push({
            artifactId,
            callId: entry.message.toolCallId,
            toolName: entry.message.toolName,
            // The round, from the same checkpointed counter the approval path
            // uses, so `task.review_required` and `review` can address it.
            steps: current.steps,
          });
        }
      }
      const request: WorkflowReviewInterrupt = { requests };
      // Where the person is (a Telegram chat), they hear that the turn waits on a review they cannot give there.
      if (options.announceReview !== undefined) {
        try {
          await options.announceReview({ taskId: current.runId, steps: current.steps, invocation: current.invocation, requests });
        } catch (error) {
          options.onDiagnostic?.("a review the turn waits on could not be announced", {
            taskId: current.runId,
            steps: current.steps,
            error: errorMessage(error),
          });
        }
      }
      // The node restarts from the top on resume (see this node's own doc
      // comment), so nothing here writes durable state before `interrupt`
      // — unlike `approveNode`, the durable state this node depends on
      // (each artifact's `reviewState`) was already written by its
      // producer, before this node ever ran.
      interrupt(request);
      // Reached only on a resumed pass whose resume value satisfied this
      // exact interrupt() call. Loop back to re-derive state: if the
      // operator resolved everything, the next iteration returns; if not,
      // the next iteration's `interrupt()` call has no resume value
      // available and suspends again.
    }
  };
  return reviewNode;
}

/** The finalize node: a turn's last write. */
export function createFinalizeNode(scope: WorkflowScope): WorkflowNode {
  const { options } = scope;
  const finalizeNode: WorkflowNode = async (state, config) => {
    // A node result is checkpointed, so finalize is a write boundary too.
    await assertLeaseCurrent(options, config);
    const current = parseAgentState(state);
    if (current.phase === "failed") return {};
    return { phase: "completed" as const };
  };
  return finalizeNode;
}
