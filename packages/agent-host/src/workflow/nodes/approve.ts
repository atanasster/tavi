import { interrupt } from "@langchain/langgraph";
import {
  escapeGlob,
  isAutomaticDecider,
  toolPatternMatches,
  type ApprovalScope,
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  approvalRowId,
  parseAgentState,
  type GateVerdict,
  APPROVAL_RULE_NOTE_PREFIX,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { type ApprovalRequestPayload, ApprovalReplySchema, parseApprovalReply, ruleOrigin } from "../approval.js";
import { CallSchema, validateToolInput } from "../dispatch.js";
import { executionLeaseOf, assertLeaseCurrent } from "../run-config.js";
import type { WorkflowScope } from "../scope.js";
import type { WorkflowUpdate, WorkflowNode } from "../state.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, handoffAllowed } from "../waits.js";

/** The approve node: the round that asks a person about the pending calls that need it. */
export function createApproveNode(scope: WorkflowScope): WorkflowNode {
  const { approvalFor, callNeedsApproval, executionPolicyOf, now, options, provenanceOfVerdict, toolDisclosureRefusal, verdictOf } = scope;
  /**
   * What a wider decision on a grouped call writes. A grant names one tool, so
   * a session is one grant per tool of the group that asks. A grouped
   * decision is for the hosts its call named (`GateVerdict.scopeHosts`: a
   * URL-only request's destinations, or the page a click lands on): every
   * tool of the group is granted for those hosts only, so another site — one
   * a click or a redirect led to, too — is asked about again. A call that
   * named no host grants no tool that acts on a page and sends what it does
   * (a click, a submit, acting by sight), and a URL-only one only for calls
   * that name no URL (the gate holds a named destination to a grant for it).
   * A group with neither keeps one standing rule for its pattern.
   */
  const groupTargets = (
    group: string,
    verdict: GateVerdict,
    scope: "session" | "always",
  ): readonly { readonly tool: string; readonly argMatcher: string | undefined }[] => {
    const members = [
      ...new Set([
        verdict.toolId,
        ...options.tools
          .list()
          .filter((tool) => approvalFor.has(tool.effect) && toolPatternMatches(group, tool.id))
          .map((tool) => tool.id),
      ]),
    ];
    const hosts = (verdict.scopeHosts ?? []).map(escapeGlob).filter((matcher) => matcher.length <= 512);
    if (hosts.length > 0) return members.flatMap((tool) => hosts.map((argMatcher) => ({ tool, argMatcher })));
    // With no host named, a tool that acts on a page and sends what it does (a network sink that is not a
    // URL-only request: a click, a submit, acting by sight) is not granted: it is asked about again on its own host.
    // A URL-only request is granted for its calls that name no URL; the gate never lets this grant cover one that does.
    const reachesOut = (id: string): boolean => {
      const tool = options.tools.get(id);
      return tool?.sink === "network" && tool.urlOnly !== true;
    };
    if (scope === "always" && !members.some(reachesOut)) return [{ tool: group, argMatcher: undefined }];
    return members.filter((tool) => !reachesOut(tool)).map((tool) => ({ tool, argMatcher: undefined }));
  };
  const approveNode: WorkflowNode = async (state, config): Promise<WorkflowUpdate> => {
    const current = parseAgentState(state);
    // This node writes durable approval rows, so it is a write boundary.
    await assertLeaseCurrent(options, config);
    const policy = await executionPolicyOf(current.runId);
    const parsedCalls = current.pendingToolCalls.map((raw) => CallSchema.parse(raw));
    const disclosureRefusals = new Map<string, string>();
    for (const call of parsedCalls) {
      const refusal = await toolDisclosureRefusal(current, call.name, call.input);
      if (refusal !== undefined) disclosureRefusals.set(call.id, refusal);
    }
    const suppressed = parsedCalls.filter(
      (call) =>
        disclosureRefusals.has(call.id) ||
        (call.name === ASK_USER_TOOL_ID && !policy.humanQuestionsAllowed) ||
        (call.name === BROWSER_REQUEST_HANDOFF_TOOL_ID && !handoffAllowed(policy)) ||
        (call.name === AGENTS_WAIT_TOOL_ID && !policy.workerWaitsAllowed),
    );
    // A round this policy is suppressing may have been requested by an earlier
    // build — before the policy existed, or before the task's row was backfilled
    // — and its row would otherwise stay `pending` forever, listed by
    // `tavi approvals` as work still owed. Settle it as denied, with the reason,
    // so the ledger matches what actually happened: nobody was asked.
    if (suppressed.length > 0) {
      // Matched on the call's **identity**, not just its id. A provider reuses
      // call ids across rounds (`sameAuthorization` below compares id, tool and
      // inputs for the same reason), so an id-only match would deny — and label
      // "this task cannot ask a person" — a pending authorization for an
      // unrelated tool that merely shares the id.
      const suppressedTools = new Map(suppressed.map((call) => [call.id, call.name]));
      for (const row of await options.approvals.listForTask(current.runId)) {
        if (row.state !== "pending" || suppressedTools.get(row.callId) !== row.toolId) continue;
        await options.approvals.decide({
          approvalId: row.approvalId,
          state: "denied",
          decidedBy: "policy",
          note: (await toolDisclosureRefusal(current, row.toolId)) ?? "not delivered: this task cannot ask a person",
          now: { fixed: now() },
        });
      }
    }
    const eligible = current.pendingToolCalls
      .map((raw) => CallSchema.parse(raw))
      .filter((call) => !disclosureRefusals.has(call.id))
      .filter((call) => !suppressed.some((entry) => entry.id === call.id));
    // A call the policy refused never reaches a person: no round, no row, and
    // the reason is the model's tool result.
    const policyDenials: Record<string, string> = {};
    for (const call of eligible) {
      const verdict = verdictOf(current, call);
      if (verdict?.decision === "deny") policyDenials[call.id] = verdict.reason ?? "refused by policy";
    }
    const gated = eligible.filter((call) => policyDenials[call.id] === undefined && callNeedsApproval(current, call));

    if (gated.length === 0) return Object.keys(policyDenials).length === 0 ? {} : { denials: policyDenials };

    // A cancelled task never presents an approval: cancellation is authoritative.
    const cancellation = await options.cancellations.get(current.runId);
    if (cancellation !== undefined) {
      return {
        phase: "failed" as const,
        finalText: `Task was cancelled by ${cancellation.requestedBy}: ${cancellation.reason}`,
      };
    }

    /**
     * One decision per pending call.
     *
     * A single generation may request several gated tools, so the request carries
     * every payload and the resume reply is keyed by call id. A bare
     * `{ approved }` applies to the whole request, which is what a single-call
     * approval and the CLI's `--approval` flag produce.
     */
    const request: ApprovalRequestPayload = {
      requests: gated.map((call) => {
        // From the checkpoint, so the payload is the same on every re-entry.
        const verdict = verdictOf(current, call);
        return {
          callId: call.id,
          toolName: call.name,
          summary: verdict === undefined ? `Approve ${call.name}?` : verdict.display.title,
          input: call.input,
          // `current.steps` is this model call's generation, checkpointed, so the
          // round is derivable from durable state rather than from an in-memory id.
          steps: current.steps,
          ...(verdict === undefined
            ? {}
            : {
                risk: verdict.risk,
                display: verdict.display,
                allowedScopes: verdict.allowedScopes,
                ...(verdict.subjects === undefined ? {} : { subjects: verdict.subjects }),
                ...(verdict.scopeGroup === undefined ? {} : { scopeGroup: verdict.scopeGroup }),
                tainted: verdict.risk.tainted,
                ...definedOnly({
                  askWhenTainted: verdict.askWhenTainted,
                  attendedOnly: verdict.attendedOnly,
                  effect: verdict.effect,
                  gateReason: verdict.gateReason,
                }),
              }),
          ...provenanceOfVerdict(verdict),
        };
      }),
    };

    // The node restarts from the top on resume, so `interrupt` must be the first
    // side-effecting call in this node and its payload must be deterministic.
    // The request is durable BEFORE the operator is asked, so a crash while
    // waiting still leaves a record of exactly what was authorized.
    for (const entry of request.requests) {
      // Bind the NORMALIZED inputs, which is the value the handler will receive;
      // binding the raw model input would make the dispatch-time comparison fail
      // for any schema with a default or transform.
      const normalized = validateToolInput(options.tools, entry.toolName, entry.input);
      await options.approvals.request({
        // Round-qualified, so a `callId` the provider reuses in a later turn
        // writes a new row instead of colliding with the earlier round's.
        approvalId: approvalRowId(current.runId, entry.callId, current.steps),
        taskId: current.runId,
        admissionId: executionLeaseOf(config)?.admissionId ?? "unknown",
        toolId: entry.toolName,
        callId: entry.callId,
        steps: current.steps,
        inputs: normalized.ok ? normalized.value : entry.input,
        now: { fixed: now() },
      });
    }

    if (options.announceRound !== undefined) {
      try {
        await options.announceRound({
          taskId: current.runId,
          steps: current.steps,
          invocation: current.invocation,
          requests: request.requests.map((entry) => ({
            ...entry,
            subjects: verdictOf(current, { id: entry.callId, name: entry.toolName })?.subjects,
          })),
        });
      } catch (error) {
        options.onDiagnostic?.("an approval round could not be announced", {
          taskId: current.runId,
          steps: current.steps,
          error: errorMessage(error),
        });
      }
    }

    const reply: unknown = interrupt(request);
    const decisions = parseApprovalReply(reply, request.requests);
    const replyVia = ApprovalReplySchema.safeParse(reply).data?.via;

    const requestByCall = new Map(request.requests.map((entry) => [entry.callId, entry]));

    const denials: Record<string, string> = { ...policyDenials };
    const approvals: Record<string, string> = {};
    for (const entry of decisions) {
      const approvalId = approvalRowId(current.runId, entry.callId, current.steps);
      const state = entry.approved ? ("granted" as const) : ("denied" as const);
      // The durable decision is the authority the ledger binds to.
      await options.approvals.decide({
        approvalId,
        state,
        decidedBy: entry.decidedBy ?? "operator",
        ...(entry.note === undefined ? {} : { note: entry.note }),
        now: { fixed: now() },
      });
      if (entry.approved) {
        approvals[entry.callId] = approvalId;
      } else {
        // Nobody declined what a blanket `--approval deny` refused.
        denials[entry.callId] =
          entry.note ?? (isAutomaticDecider(entry.decidedBy ?? "operator") ? "denied by operator" : "the person declined this call");
      }
    }

    // A wider scope is applied only where the call's verdict offered it; a
    // front end cannot turn a risky or tainted call into a standing grant.
    const applied = new Map<string, ApprovalScope>();
    const created = new Map<string, readonly { readonly id: string; readonly argMatcher?: string }[]>();
    for (const entry of decisions) {
      const requested = requestByCall.get(entry.callId);
      const verdict = requested === undefined ? undefined : verdictOf(current, { id: entry.callId, name: requested.toolName });
      // A person's approval that names no scope — `y`, a bare `approve`, the
      // CLI without `--scope` — allows a grouped call's group for the task:
      // "use the browser" is one question, not one per page. An explicit
      // `once` stays one call, and a decision made unseen never widens.
      const grouped =
        verdict?.scopeGroup !== undefined &&
        verdict.allowedScopes.includes("session") &&
        !isAutomaticDecider(entry.decidedBy ?? "operator");
      const wanted = entry.scope ?? (grouped ? "session" : "once");
      // One entry per subject, each matching exactly what was shown; a call
      // with no subjects is granted for its tool as a whole. A matcher that
      // would not fit whole is never clipped: the grant falls back to once.
      // A grouped call is decided for its group (`browser.*`): `groupTargets` says what that writes.
      // A grant for the rest of a chat may cover a command's variants, as its card said (`sessionMatchers`).
      const matchers: readonly (string | undefined)[] =
        verdict?.scopeGroup !== undefined || verdict?.subjects === undefined || verdict.subjects.length === 0
          ? [undefined]
          : wanted === "session" && verdict.sessionMatchers !== undefined && verdict.sessionMatchers.length > 0
            ? verdict.sessionMatchers
            : verdict.subjects.map(escapeGlob);
      const fits = matchers.every((matcher) => matcher === undefined || matcher.length <= 512);
      // Without the hook that stores it, a wider scope would be reported and never kept.
      const stores =
        wanted === "session"
          ? options.toolPolicy?.grantSession !== undefined
          : wanted === "always"
            ? options.toolPolicy?.addRule !== undefined
            : false;
      const scope: ApprovalScope =
        entry.approved && wanted !== "once" && stores && fits && verdict?.allowedScopes.includes(wanted) === true ? wanted : "once";
      applied.set(entry.callId, scope);
      if (scope === "once" || verdict === undefined) continue;
      const approvalId = approvalRowId(current.runId, entry.callId, current.steps);
      const decidedBy = entry.decidedBy ?? "operator";
      // Bounded, collision-free ids derived from the row, so a re-entered node
      // writes the same grant or rule again rather than another one.
      const approvalKey = sha256Hex(approvalId).slice(0, 40);
      const createdHere: { id: string; argMatcher?: string }[] = [];
      created.set(entry.callId, createdHere);
      const group = verdict.scopeGroup;
      const targets =
        group === undefined ? matchers.map((argMatcher) => ({ tool: verdict.toolId, argMatcher })) : groupTargets(group, verdict, scope);
      for (const [index, { tool, argMatcher }] of targets.entries()) {
        createdHere.push({
          id: `${scope === "session" ? "grant" : "rule"}-${approvalKey}-${index}`,
          ...(argMatcher === undefined ? {} : { argMatcher }),
        });
        if (scope === "session") {
          await options.toolPolicy?.grantSession?.({
            grantId: `grant-${approvalKey}-${index}`,
            taskId: current.runId,
            workspaceId: current.invocation.workspaceId,
            toolId: tool,
            ...(argMatcher === undefined ? {} : { argMatcher }),
            ...(verdict.bindingHash === undefined ? {} : { bindingHash: verdict.bindingHash }),
            approvalId,
            createdBy: decidedBy,
            createdAt: now(),
          });
        } else {
          await options.toolPolicy?.addRule?.({
            ruleId: `rule-${approvalKey}-${index}`,
            workspaceId: current.invocation.workspaceId,
            toolPattern: tool,
            ...(argMatcher === undefined ? {} : { argMatcher }),
            ...(verdict.bindingHash === undefined ? {} : { bindingHash: verdict.bindingHash }),
            decision: "allow",
            source: "operator",
            createdBy: decidedBy,
            createdVia: ruleOrigin(replyVia),
            createdAt: now(),
            note: `${APPROVAL_RULE_NOTE_PREFIX}${current.steps} of ${current.runId}`.slice(0, 500),
            fromApproval: true,
          });
        }
      }
    }

    if (options.onRoundSettled !== undefined) {
      try {
        await options.onRoundSettled({
          taskId: current.runId,
          steps: current.steps,
          invocation: current.invocation,
          ...(replyVia === undefined ? {} : { via: replyVia }),
          decisions: decisions.map((entry) => {
            const made = created.get(entry.callId);
            return {
              callId: entry.callId,
              toolName: requestByCall.get(entry.callId)?.toolName ?? "unknown",
              approved: entry.approved,
              scope: applied.get(entry.callId) ?? "once",
              decidedBy: entry.decidedBy ?? "operator",
              ...(entry.note === undefined ? {} : { note: entry.note }),
              ...(made === undefined ? {} : { created: made }),
            };
          }),
        });
      } catch (error) {
        options.onDiagnostic?.("an approval round's settlement could not be reported", {
          taskId: current.runId,
          steps: current.steps,
          error: errorMessage(error),
        });
      }
    }

    // A novel URL a person approved is known for the rest of the task: the
    // same address is not asked about again. A decision made unseen adds none.
    const approvedUrls = decisions.flatMap((entry) => {
      if (!entry.approved || isAutomaticDecider(entry.decidedBy ?? "operator")) return [];
      const requested = requestByCall.get(entry.callId);
      const verdict = requested === undefined ? undefined : verdictOf(current, { id: entry.callId, name: requested.toolName });
      return verdict?.gateReason === "novel-url" ? (verdict.urls ?? []) : [];
    });

    // A denied call becomes an error *result*, not a failed task: the model can
    // still answer without the effect, and the tool never executes.
    return {
      ...(Object.keys(denials).length === 0 ? {} : { denials }),
      ...(Object.keys(approvals).length === 0 ? {} : { approvals }),
      ...(approvedUrls.length === 0 ? {} : { knownUrls: approvedUrls }),
    };
  };
  return approveNode;
}
