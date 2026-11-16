import { z } from "zod";
import { type AgentWaitOutcome, ASK_USER_CONTEXT_MAX_CHARS, type AskUserChoices, AskUserChoicesSchema } from "../agent-communication.js";
import { type ConnectRequest, ConnectRequestSchema } from "../app-connect.js";
import { type BrowserHandoff, BrowserHandoffSchema } from "../browser-handoff.js";
import type { ApprovalDisplay } from "../approval-card.js";
import type { ApprovalProvenance, ApprovalScope, GateReason, GateVerdict } from "../tool-policy.js";

/**
 * An operator decision on a suspended approval.
 *
 * A single admission may be waiting on several gated tool calls, so the decision
 * is expressed per call. `approved` applies to the whole request when
 * `decisions` is omitted, which is what a single-call approval looks like.
 */
export interface WorkflowResumeDecision {
  /**
   * Applies to every pending call when `decisions` is absent.
   *
   * Optional because a decision is expressed one way or the other: supplying
   * both would create an unread contradiction.
   */
  readonly approved?: boolean;
  readonly note?: string;
  /** Who made the decision; recorded on the durable approval. */
  readonly decidedBy?: string;
  /**
   * How long an approval stands: `once` (the default), `session` for
   * the rest of the task, `always` as a workspace rule. Applied per call only
   * where the call's verdict offered it; otherwise the grant is `once`.
   */
  readonly scope?: ApprovalScope;
  /** The front end or channel the decision came through, for the audit trail. Attribution, like `decidedBy`. */
  readonly via?: string;
  /**
   * Per-call decisions. When present this is authoritative and `approved` is
   * ignored, so a caller must not rely on mixing the two.
   */
  readonly decisions?: readonly {
    readonly callId: string;
    readonly approved: boolean;
    readonly note?: string;
    /** Who made this call-level decision; recorded durably. */
    readonly decidedBy?: string;
    readonly scope?: ApprovalScope;
  }[];
  /**
   * The answer to a suspended wait interrupt, mutually exclusive with
   * `approved`/`decisions` (a resume answers exactly one kind of
   * suspension). A single `resume` field stays the one caller-facing
   * concept — "the value this suspended admission was waiting to
   * receive" — rather than a second, parallel `waitResume` field on
   * `AdmitInput`.
   */
  readonly waitOutcome?: AgentWaitOutcome;
  /**
   * The wait `waitOutcome` settles, for the `wait.settled` event its claim
   * publishes. Attribution, like `decidedBy` and `via`:
   * not part of the resume's identity.
   */
  readonly waitId?: string;
  /**
   * The round this decision is meant for.
   *
   * A provider may reuse one `call.id` across turns, so a decision keyed on
   * `callId` alone can be applied to the wrong round. Supplied by a caller that
   * read the round off an `approval.required`/`task.review_required` event.
   *
   * A **precondition**, checked inside the task's serialized region before any
   * node runs: the task's pending round (`pendingRoundOf`) must be of this
   * resume's kind with this `steps`, and a `decisions` list must name exactly its
   * calls. On a mismatch the admission is committed `refused` — the task stays
   * waiting — and `admit` rejects `CONFLICT`, as does any retry under that key.
   * That is what refuses a decision meant for a round that has since been
   * replaced, which with reused call ids would otherwise be applied to the new
   * round. Absent means "whatever round is pending".
   */
  readonly expectedSteps?: number;
  /**
   * The answer to a suspended artifact-review interrupt, mutually
   * exclusive with `approved`/`decisions`/`waitOutcome`. Deliberately
   * carries no decision of its own — the real decision already lives
   * durably on the artifact record (`ArtifactRepositoryPort
   * .setReviewState`, set out-of-band by `tavi artifacts approve|reject`
   * before this resume is even issued) — `reviewAck: true` is purely the
   * wake-up signal LangGraph's `Command({ resume })` mechanism requires
   * to re-enter the suspended node, which then re-reads current artifact
   * state itself rather than trusting anything in this payload. This
   * mirrors `agents.wait`'s own "durable row is the truth, the resume
   * value is only a nudge" discipline.
   */
  readonly reviewAck?: true;
}

/** A single suspended approval request. */
export interface WorkflowApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
  /** Effect classification, so a client can present the risk honestly. */
  readonly effect: string;
  /** The policy verdict's risk, when the round was raised by a build that records it. */
  readonly risk?: GateVerdict["risk"];
  /** What the person is shown about the call. */
  readonly display?: ApprovalDisplay;
  /** The scopes a decision on this call may carry; absent means `once` only. */
  readonly allowedScopes?: readonly ApprovalScope[];
  /** The call's rule subjects a `session`/`always` decision matches; empty or absent covers any call of the tool. */
  readonly subjects?: readonly string[];
  /** The tools a `session` or `always` decision covers as one permission (`browser.*`). */
  readonly scopeGroup?: string;
  /**
   * What a schedule fire reads to deny the call whatever its tool list
   * (`unattendedDenial`): the
   * conversation was tainted when the call was emitted, the tool asks under
   * taint, and why the taint step asked. Absent on a round raised before them.
   */
  readonly tainted?: boolean;
  readonly askWhenTainted?: boolean;
  /** Only a person decides it (`CallAssessment.attendedOnly`): every unattended run denies it. */
  readonly attendedOnly?: boolean;
  readonly gateReason?: GateReason;
  /** Why the call is asked, and from where: the card's reason, source chips and argument origins. Absent on an older round, or with nothing to say. */
  readonly provenance?: ApprovalProvenance;
  /**
   * The checkpointed per-turn generation counter this request belongs to.
   * It is the round identity — a provider may reuse one `call.id`
   * across turns, so `callId` alone does not name a round.
   *
   * The graph writes it for every round.
   */
  readonly steps: number;
}

/**
 * A suspension surfaced to the caller.
 *
 * `requests` carries every pending decision: a model may legitimately request
 * several tools in one generation, and hiding all but the first would make the
 * approval meaningless.
 */
export interface WorkflowInterrupt {
  readonly requests: readonly WorkflowApprovalRequest[];
}

/**
 * A single suspended wait (`waitFor`) — distinct from an
 * approval suspension, not a variant of it: a wait is one predicate
 * (correlation match, worker completion, or deadline), never a set of
 * pending decisions the way `WorkflowInterrupt.requests` is.
 */
export interface WorkflowWaitRequest {
  readonly waitId: string;
  readonly correlationId?: string;
  readonly waitingOnWorkerTaskId?: string;
  readonly deadlineAt: string;
  /** What `operator.ask_user` asked; see `WorkflowWaitRequestSchema.question`. */
  readonly question?: string;
  /** The question's choices, when it offers some. */
  readonly choices?: AskUserChoices;
  /** A browser handoff's. */
  readonly handoff?: BrowserHandoff;
  /** A connect wait's. */
  readonly connect?: ConnectRequest;
}

/**
 * Zod-derived counterpart of `WorkflowWaitRequest` — the single source of
 * truth `workflow.ts` parses the raw `interrupt()`/resume payload against,
 * so the schema and the interface can't drift out of sync the way two
 * independently hand-written shapes could.
 */
export const WorkflowWaitRequestSchema = z.object({
  waitId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  waitingOnWorkerTaskId: z.string().min(1).optional(),
  deadlineAt: z.string().min(1),
  /**
   * The question a human is answering, when this wait is `operator.ask_user`'s
   * bare-deadline shape.
   *
   * Carried on the payload so an attached client that joined *after* the
   * question was asked can still show what is being asked — the message went to
   * a chat channel, and without this the TUI would show a bare deadline.
   */
  question: z.string().max(4000).optional(),
  /** The question's choices, so an attached client can offer them. */
  choices: AskUserChoicesSchema.optional(),
  /** Why the question is asked. */
  context: z.string().max(ASK_USER_CONTEXT_MAX_CHARS).optional(),
  /** A browser handoff: the person acts in the page from the live view. */
  handoff: BrowserHandoffSchema.optional(),
  /** A connect wait: an app's account to sign in again. */
  connect: ConnectRequestSchema.optional(),
});

/** A wait suspension surfaced to the caller — parallel to `WorkflowInterrupt`, not a variant of it. */
export interface WorkflowWaitInterrupt {
  readonly wait: WorkflowWaitRequest;
  /** Present for a wait a human answers; see `WorkflowWaitRequestSchema.question`. */
  readonly question?: string;
  readonly choices?: AskUserChoices;
  /** Why the question is asked. */
  readonly context?: string;
  readonly handoff?: BrowserHandoff;
  readonly connect?: ConnectRequest;
}

/**
 * One artifact awaiting review — deciding whether an
 * already-produced result may be trusted, not whether a call may run.
 * `callId`/`toolName` identify the tool call that produced it, so an
 * operator sees the same context an approval request would show; the
 * durable decision itself lives on `ArtifactRecord.reviewState`
 * (`ArtifactRepositoryPort.setReviewState`), not on a parallel ledger —
 * this request is a read-only projection of that state at suspend time,
 * re-derived fresh (never trusted stale) on every resumed re-entry.
 */
export interface WorkflowReviewRequest {
  readonly artifactId: string;
  readonly callId: string;
  readonly toolName: string;
  /**
   * The checkpointed per-turn generation counter, mirroring
   * `WorkflowApprovalRequest.steps`: `task.review_required` carries a
   * round and `review` accepts `expectedSteps`, so the round has to exist on
   * this path as well or the event field has no source.
   */
  readonly steps: number;
}

/** Zod-derived counterpart of `WorkflowReviewRequest` — the schema `workflow.ts` parses the raw `interrupt()` payload against, mirroring `WorkflowWaitRequestSchema`'s identical rationale. */
export const WorkflowReviewRequestSchema = z.object({
  artifactId: z.string().min(1),
  steps: z.number().int().nonnegative(),
  callId: z.string().min(1),
  toolName: z.string().min(1),
});

export interface WorkflowReviewInterrupt {
  readonly requests: readonly WorkflowReviewRequest[];
}
