import { z } from "zod";
import {
  type ToolRule,
  type ApprovalScope,
  GateVerdictSchema,
  ApprovalProvenanceSchema,
  ApprovalDisplaySchema,
  ApprovalScopeSchema,
  MAX_WORKFLOW_TOOL_CALLS,
  TaviError,
  APPROVAL_NOTE_MAX_CHARS,
  WorkflowReviewRequestSchema,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/** A single request inside the approval interrupt payload. */
const ApprovalRequestEntrySchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().max(2000),
  input: z.unknown(),
  /**
   * The checkpointed per-turn generation counter.
   *
   * The round identity: a provider may reuse one `call.id` across turns
   * ("a counter-style scheme does exactly that", see `deterministicWaitId`), so
   * a decision keyed on `callId` alone can be applied to the wrong round. Carried
   * on the interrupt payload so it survives into the waiting admission's durable
   * outcome and reaches every client event built from it.
   */
  steps: z.number().int().nonnegative(),
  /** The call's verdict risk, display and offered scopes; absent on a round raised before verdicts. */
  risk: GateVerdictSchema.shape.risk.optional(),
  display: ApprovalDisplaySchema.optional(),
  allowedScopes: z.array(ApprovalScopeSchema).max(3).optional(),
  /** The call's rule subjects a `session`/`always` decision matches; absent or empty covers any call of the tool. */
  subjects: GateVerdictSchema.shape.subjects,
  /** The tools a `session`/`always` decision covers as one permission (`browser.*`). */
  scopeGroup: GateVerdictSchema.shape.scopeGroup,
  /**
   * What a schedule fire denies by, whatever its tool list:
   * the verdict's taint, its assessor's
   * `askWhenTainted` and the taint step's reason. Optional, so a round raised
   * before them parses. The payload is rebuilt from the checkpointed verdict on
   * re-entry, so such a round gets `tainted` and any `gateReason` the verdict
   * holds; only an older verdict lacks `askWhenTainted`.
   */
  tainted: z.boolean().optional(),
  askWhenTainted: z.boolean().optional(),
  /** The assessor's `attendedOnly`: denied by every unattended run. */
  attendedOnly: z.boolean().optional(),
  /** The call's effect when its assessment raised it (`GateVerdict.effect`): what the person is asked about and the client shows. */
  effect: GateVerdictSchema.shape.effect,
  gateReason: GateVerdictSchema.shape.gateReason,
  /** Why the call is asked, and from where: built from the checkpointed verdict, so the same on every re-entry. */
  provenance: ApprovalProvenanceSchema.optional(),
});

/** Interrupt payload: every gated call in one generation. */
export const ApprovalRequestSchema = z.object({ requests: z.array(ApprovalRequestEntrySchema).min(1).max(64) });

export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestSchema>;

/**
 * Interrupt payload: every artifact still pending review in one generation
 * (`reviewNode`). Bounded generously above the real worst
 * case, not copied from `ApprovalRequestSchema`'s `.max(64)` — a review
 * request is one entry per *artifact id*, and a single generation can
 * legitimately dispatch up to `MAX_WORKFLOW_TOOL_CALLS` (64) tool calls,
 * each of whose message can flag up to 16 artifact ids
 * (`WorkflowMessageSchema.pendingReviewArtifactIds`, `@tavi/contracts`) —
 * `64 * 16 = 1024` in the worst case. A `.max(64)` here would be unsafe:
 * exceeding it makes `interrupt()` throw an unvalidated payload that fails
 * every schema in `runInvocation`'s three-way parse, silently downgrading
 * to an empty, unresumable `interrupt: { requests: [] }` and wedging the
 * task with no way to decide it. `reviewNode` also dedupes by artifact id
 * before building this payload, so the practical count is usually far
 * below the worst case; this bound is a hard backstop, not the primary
 * defense.
 */
const MAX_REVIEW_REQUESTS = MAX_WORKFLOW_TOOL_CALLS * 16;

export const ReviewRequestListSchema = z.object({ requests: z.array(WorkflowReviewRequestSchema).min(1).max(MAX_REVIEW_REQUESTS) });

const ApprovalScopeReplySchema = z.enum(["once", "session", "always"]);

// The note bound is the IPC schema's too (`APPROVAL_NOTE_MAX_CHARS`): a reply
// this parser refuses fails the task, so no front end may accept a longer one.
export const ApprovalReplySchema = z.object({
  approved: z.boolean().optional(),
  note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional(),
  decidedBy: z.string().min(1).max(128).optional(),
  scope: ApprovalScopeReplySchema.optional(),
  via: z.string().min(1).max(128).optional(),
  decisions: z
    .array(
      z.object({
        callId: z.string().min(1),
        approved: z.boolean(),
        note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional(),
        decidedBy: z.string().min(1).max(128).optional(),
        scope: ApprovalScopeReplySchema.optional(),
      }),
    )
    .optional(),
});

/**
 * Resolve a resume reply into exactly one decision per pending call.
 *
 * An unknown or duplicated call id is refused rather than guessed at, because a
 * misread approval would authorize an effect the operator did not see.
 */
export function parseApprovalReply(
  reply: unknown,
  requests: readonly z.infer<typeof ApprovalRequestEntrySchema>[],
): readonly {
  readonly callId: string;
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
  readonly scope?: ApprovalScope;
}[] {
  const parsed = ApprovalReplySchema.safeParse(reply);
  if (!parsed.success) {
    throw new TaviError("APPROVAL_DENIED", "Approval reply was not a recognized decision");
  }

  if (parsed.data.decisions === undefined) {
    const approved = parsed.data.approved;
    if (approved === undefined) {
      throw new TaviError("APPROVAL_DENIED", "Approval reply omitted every decision");
    }
    return requests.map((request) => ({
      callId: request.callId,
      approved,
      ...definedOnly({
        note: parsed.data.note,
        decidedBy: parsed.data.decidedBy,
        scope: parsed.data.scope,
      }),
    }));
  }

  const byCall = new Map<
    string,
    { approved: boolean; note?: string | undefined; decidedBy?: string | undefined; scope?: ApprovalScope | undefined }
  >();
  for (const decision of parsed.data.decisions) {
    if (byCall.has(decision.callId)) {
      throw new TaviError("APPROVAL_DENIED", `Approval reply repeated call ${decision.callId}`);
    }
    byCall.set(decision.callId, decision);
  }
  return requests.map((request) => {
    const decision = byCall.get(request.callId);
    if (decision === undefined) {
      throw new TaviError("APPROVAL_DENIED", `Approval reply omitted call ${request.callId}`);
    }
    return {
      callId: request.callId,
      approved: decision.approved,
      ...definedOnly({
        note: decision.note,
        decidedBy: decision.decidedBy,
        scope: decision.scope,
      }),
    };
  });
}

/** The channel a decision came through, as a rule records its origin. */
export function ruleOrigin(via: string | undefined): ToolRule["createdVia"] {
  if (via === "cli" || via === "ipc" || via === "bridge") return via;
  return via === undefined ? "ipc" : "channel";
}
