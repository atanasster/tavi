import { Fragment, useEffect, useRef, useState } from "react";
import type { PendingRound } from "@tavi/client/browser";
import { displaySafe, toolGroupLabel, toolGroupScopeNote, type ApprovalScope } from "@tavi/contracts";
import { InlineConfirm, Notice } from "../../ui/Parts.js";
import { decidableRound } from "./store/runs.js";
import type { CanvasRun, CanvasStore } from "./store/types.js";
import { Button } from "../../ui/Button.js";
import { CallLine, describeRequest } from "./ApprovalParts.js";

type Decision = { readonly callId: string; readonly approved: boolean; readonly note?: string };

/** The most a rejection's reason may say: the agent reads it as the call's result. */
export const REJECT_REASON_MAX = 500;

/** What a round's second step says before approved calls run: a critical one (`single`: the only call) is named so. */
export function confirmCallsText(critical: boolean, single = false): string {
  if (!critical) return "Confirm these tool actions. Approved calls may change local data.";
  return single ? "This call is rated critical risk. Confirm to run it." : "A call here is rated critical risk. Confirm to run it.";
}

/** What a grouped round allows, as its card names it: the browser on the hosts its calls open. */
export function roundGroupName(
  group: string,
  round: { readonly requests: readonly { readonly display?: { readonly host?: string | undefined } | undefined }[] },
): string {
  return toolGroupLabel(
    group,
    round.requests.flatMap((request) => (request.display?.host === undefined ? [] : [request.display.host])),
  );
}

/**
 * `lastingChat`: the run is a turn of a chat that never ends — a Home, or a
 * messaging conversation's chat — where "Allow for this chat" lasts a day or
 * until the chat rolls over, and says so: "Allow until tomorrow".
 */
export function Approvals({
  run,
  onDecide,
  lastingChat = false,
}: {
  readonly run: CanvasRun;
  readonly onDecide: CanvasStore["decide"];
  readonly lastingChat?: boolean;
}) {
  // A decided round is not drawn here: the chat panel's Activity lists it
  // (`decisionsOf`), so answered questions do not crowd the transcript.
  return (
    <>
      {run.run.pending.map((pending) => (
        <section className="round" aria-label="permission required" key={pending.steps}>
          <Pending run={run} round={pending} onDecide={onDecide} lastingChat={lastingChat} />
        </section>
      ))}
    </>
  );
}

/** One call's decision, as a line of the chat's record. */
export interface DecidedCall {
  readonly key: string;
  readonly callId: string;
  readonly steps: number;
  readonly at: string;
  readonly approved: boolean;
  readonly toolName: string;
  readonly description: string | undefined;
  /** Who decided it, as the panel says it: "you", or the decider's name. */
  readonly decider: string;
}

/** Every call a run's settled rounds decided, in the order they were. */
export function decisionsOf(run: CanvasRun): readonly DecidedCall[] {
  return run.run.settled.flatMap((settled) => {
    const requests = run.approvalHistory?.[settled.steps]?.requests ?? [];
    return settled.decisions.map((decision) => {
      const request = requests.find((candidate) => candidate.callId === decision.callId);
      return {
        key: `${run.id}:decision:${settled.steps}:${decision.callId}`,
        callId: decision.callId,
        steps: settled.steps,
        at: settled.at,
        approved: decision.approved,
        toolName: request?.toolName ?? decision.callId,
        description: request === undefined ? undefined : describeRequest(request),
        decider: deciderName(settled.decidedBy, decision.approved),
      };
    });
  });
}

/**
 * Who decided a round, as the canvas says it. A blanket `tavi run --approval approve|deny` saw no call; which of the two
 * it was is the decision itself (`approved`), since the decider's id is the same for both.
 */
export function deciderName(decidedBy: string, approved?: boolean): string {
  if (decidedBy === "operator") return "you";
  if (!decidedBy.startsWith("auto:")) return decidedBy;
  return approved === false
    ? "automatic denial (--approval deny)"
    : approved === true
      ? "automatic approval (--approval approve)"
      : "--approval";
}

/** The scopes every call of the round offers; an older owner offers none beyond once. */
function roundScopes(round: PendingRound): readonly ApprovalScope[] {
  return (["once", "session", "always"] as const).filter((scope) =>
    round.requests.every((request) => (request.allowedScopes ?? ["once"]).includes(scope)),
  );
}

/**
 * What an `always` decision saves for one call: the rule the owner writes,
 * not the call's display. The rule is the tool plus one exact matcher per
 * verdict subject; with no subjects it covers any call of the tool.
 * The tool's name is its id — the gate refuses a verdict whose id differs.
 */
function ruleSubjects(request: {
  readonly toolName: string;
  readonly subjects?: readonly string[] | undefined;
  readonly scopeGroup?: string | undefined;
  readonly display?: { readonly host?: string | undefined } | undefined;
}): readonly string[] {
  if (request.scopeGroup !== undefined) return [`any ${roundGroupName(request.scopeGroup, { requests: [request] })} call`];
  return request.subjects === undefined || request.subjects.length === 0
    ? [`any ${request.toolName} call`]
    : request.subjects.map((subject) => `${request.toolName} ${displaySafe(subject)}`);
}

/**
 * The group every call of the round shares, when the round can be decided for
 * it as a whole: then the card asks one question — use the browser? — instead
 * of one per step.
 */
function roundGroup(round: PendingRound, scopes: readonly ApprovalScope[]): string | undefined {
  const group = round.requests[0]?.scopeGroup;
  if (group === undefined || !scopes.includes("session")) return undefined;
  return round.requests.every((request) => request.scopeGroup === group && request.risk?.level !== "critical") ? group : undefined;
}

/**
 * Whether approving a call takes a second, explicit step. Only a critical call
 * does: the card already shows its risk, and a second step on every change —
 * opening a browser, then again for each page — asked one decision several
 * times. A round from an owner that sends no risk keeps the older rule: a call
 * that changes something, or whose effect the card does not recognise.
 */
function needsSecondStep(request: PendingRound["requests"][number]): boolean {
  if (request.risk !== undefined) return request.risk.level === "critical";
  return request.effect !== "read-only" && request.effect !== "external";
}

/** What a `session` grant is called, and how long it lasts, where it is made. */
function sessionScopeWords(lastingChat: boolean): { readonly allow: string; readonly lasts: string } {
  return lastingChat
    ? { allow: "Allow until tomorrow", lasts: "in this chat for a day, or until it rolls over" }
    : { allow: "Allow for this chat", lasts: "for the rest of this chat" };
}

function Pending({
  run,
  round,
  onDecide,
  lastingChat,
}: {
  readonly run: CanvasRun;
  readonly round: PendingRound;
  readonly onDecide: CanvasStore["decide"];
  readonly lastingChat: boolean;
}) {
  const session = sessionScopeWords(lastingChat);
  const [rejected, setRejected] = useState<readonly string[]>([]);
  const [reason, setReason] = useState("");
  // The reason field is asked for only when there is something to deny: after
  // Deny, or for the calls a person unchecked.
  const [rejecting, setRejecting] = useState(false);
  const scopes = roundScopes(round);
  // A scoped approval covers the checked calls only; an unchecked call is rejected, as with the main button.
  const isChecked = (request: PendingRound["requests"][number]) => !rejected.includes(request.callId);
  // The typed reason goes with each unchecked call, which it is the reason for.
  const note = reason.trim();
  const perCallDecisions = (): readonly Decision[] =>
    round.requests.map((request) =>
      isChecked(request)
        ? { callId: request.callId, approved: true }
        : { callId: request.callId, approved: false, ...(note === "" ? {} : { note }) },
    );
  const chosen = (): boolean | readonly Decision[] => (perCall ? perCallDecisions() : true);
  const saved = round.requests.filter(isChecked);
  const [armed, setArmed] = useState<{ decisions: boolean | readonly Decision[]; signature: string; scope: ApprovalScope }>();
  const signature = JSON.stringify(round.requests);
  const ready = decidableRound(run)?.steps === round.steps;
  // A form whose rows did not all fit the card is denied, never approved: nobody approves values they were not shown.
  const approvable = ready && !round.requests.some((request) => request.display?.form?.truncated === true);
  const group = roundGroup(round, scopes);
  // A grouped round is one question: its calls are allowed or denied together.
  const perCall = group === undefined && round.requests.length > 1 && round.requests.length <= 64;
  const act = (decisions: boolean | readonly Decision[], scope: ApprovalScope = "once") => {
    const approves = (request: PendingRound["requests"][number]) =>
      typeof decisions === "boolean" ? decisions : decisions.some((decision) => decision.callId === request.callId && decision.approved);
    if (round.requests.some((request) => needsSecondStep(request) && approves(request))) setArmed({ decisions, signature, scope });
    else onDecide(run.id, decisions, { scope });
  };
  const reject = () => {
    setArmed(undefined);
    setRejecting(false);
    onDecide(run.id, false, { note: reason });
  };
  // The form opens where the card's buttons were: brought into view whole, its buttons above the floating composer.
  const rejectForm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rejecting) rejectForm.current?.scrollIntoView?.({ block: "center" });
  }, [rejecting]);
  const reasonField = (label: string) => (
    <label className="reject-reason">
      {label}
      <input
        type="text"
        value={reason}
        maxLength={REJECT_REASON_MAX}
        disabled={!ready}
        autoFocus={rejecting}
        placeholder="Optional"
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && rejecting) {
            event.preventDefault();
            reject();
          }
        }}
      />
    </label>
  );
  const heading =
    group !== undefined
      ? `This chat wants to use the ${roundGroupName(group, round)}`
      : round.requests.length === 1
        ? "Needs your approval"
        : `${round.requests.length} calls need your approval`;
  return (
    <>
      <p className={group === undefined ? "round-heading meta-sm" : "group-ask"}>
        <span className="visually-hidden">permission required: </span>
        {heading}
      </p>
      <ul className="round-calls list-reset">
        {round.requests.map((request) => (
          <li key={request.callId}>
            {perCall ? (
              <label>
                <input
                  type="checkbox"
                  checked={!rejected.includes(request.callId)}
                  disabled={!ready}
                  onChange={(event) => {
                    setArmed(undefined);
                    setRejected((value) =>
                      event.target.checked ? value.filter((id) => id !== request.callId) : [...value, request.callId],
                    );
                  }}
                />
                Allow{" "}
              </label>
            ) : null}
            <CallLine request={request} grouped={group !== undefined} />
          </li>
        ))}
      </ul>
      {round.requests.length > 64 ? <p>More than 64 calls: this round must be allowed or denied together.</p> : null}
      {rejecting ? (
        <div className="reject-form" ref={rejectForm}>
          {reasonField("Why deny? The agent reads the reason.")}
          <div className="actions">
            <Button variant="destructive" disabled={!ready} onClick={reject}>
              Deny
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : group !== undefined ? (
        <>
          <div className="actions">
            <Button
              variant="primary"
              className="approval-trigger"
              data-run={run.id}
              disabled={!approvable}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              onClick={() => act(true, "session")}
            >
              {session.allow}
            </Button>
            {scopes.includes("once") ? (
              <Button disabled={!approvable} onClick={() => act(true, "once")}>
                Allow once
              </Button>
            ) : null}
            {scopes.includes("always") ? (
              <Button disabled={!approvable} onClick={() => act(true, "always")}>
                Always allow
              </Button>
            ) : null}
            <Button
              variant="danger-ghost"
              disabled={!ready}
              onClick={() => {
                setArmed(undefined);
                setRejecting(true);
              }}
            >
              Deny…
            </Button>
          </div>
          {/* The buttons first; what they allow, for whoever wants to read it, behind a disclosure. */}
          <details className="approval-explain">
            <summary className="disclosure">What does this allow?</summary>
            <Notice>
              {session.allow} lets it use the {roundGroupName(group, round)} without asking again, {session.lasts}.
              {((note) => (note === undefined ? "" : ` ${note}`))(toolGroupScopeNote(group))}
              {scopes.includes("always") ? ` Always allow never asks again, in any chat — revoke it in Settings → Permissions.` : ""}
            </Notice>
          </details>
        </>
      ) : (
        <div className="actions">
          <Button
            variant="primary"
            className="approval-trigger"
            data-run={run.id}
            disabled={!approvable}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            onClick={() => act(chosen())}
          >
            {perCall ? "Allow selected; deny unchecked" : "Allow once"}
          </Button>
          {perCall ? (
            <Button
              disabled={!approvable}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              onClick={() => act(true)}
            >
              Allow the rest
            </Button>
          ) : null}
          {scopes.includes("session") && saved.length > 0 ? (
            <Button
              disabled={!approvable}
              title={`Runs without asking ${session.lasts}: ${saved.flatMap(ruleSubjects).join("; ")}`}
              onClick={() => act(chosen(), "session")}
            >
              {session.allow}
            </Button>
          ) : null}
          {scopes.includes("always") && saved.length > 0 ? (
            <Button
              disabled={!approvable}
              title={`Saves a workspace rule allowing exactly: ${saved.flatMap(ruleSubjects).join("; ")}`}
              onClick={() => act(chosen(), "always")}
            >
              Always allow
            </Button>
          ) : null}
          <Button
            variant="danger-ghost"
            disabled={!ready}
            onClick={() => {
              setArmed(undefined);
              setRejecting(true);
            }}
          >
            Deny…
          </Button>
        </div>
      )}
      {!rejecting && group === undefined && scopes.includes("always") && saved.length > 0 ? (
        <Notice>
          Always allow saves a workspace rule allowing exactly:{" "}
          {saved
            .flatMap((request) => ruleSubjects(request).map((subject, index) => ({ key: `${request.callId}:${index}`, subject })))
            .map(({ key, subject }, index) => (
              <Fragment key={key}>
                {index === 0 ? "" : "; "}
                <code>{subject}</code>
              </Fragment>
            ))}{" "}
          — see Settings → Permissions to revoke it.
        </Notice>
      ) : null}
      {!rejecting && perCall && rejected.length > 0 ? reasonField("Reason for denying the unchecked calls (the agent reads it)") : null}
      {armed?.signature === signature && ready ? (
        <InlineConfirm
          small={false}
          message={confirmCallsText(round.requests.some((request) => request.risk?.level === "critical"))}
          confirmLabel="Confirm actions"
          cancelLabel="Go back"
          onConfirmKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          onConfirm={() => {
            onDecide(run.id, armed.decisions, { scope: armed.scope });
            setArmed(undefined);
          }}
          onCancel={() => setArmed(undefined)}
        />
      ) : null}
      {!ready ? <Notice>{run.deciding === round.steps ? "Deciding…" : "Waiting for the rest of this round…"}</Notice> : null}
    </>
  );
}
