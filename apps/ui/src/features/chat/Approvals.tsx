import { Fragment, useEffect, useRef, useState } from "react";
import type { PendingRound } from "@tavi/client/browser";
import { displaySafe, toolGroupLabel, toolGroupScopeNote, type ApprovalScope } from "@tavi/contracts";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { InlineConfirm, Notice } from "../../ui/Parts.js";
import { decidableRound } from "./store/runs.js";
import type { CanvasRun, CanvasStore } from "./store/types.js";
import type { UiKey } from "../../locales/en.js";
import { Button } from "../../ui/Button.js";
import { CallLine, describeRequest } from "./ApprovalParts.js";
import { withParts } from "../../ui/with-parts.js";

type Decision = { readonly callId: string; readonly approved: boolean; readonly note?: string };

/** The most a rejection's reason may say: the agent reads it as the call's result. */
export const REJECT_REASON_MAX = 500;

/** What a round's second step says before approved calls run: a critical one (`single`: the only call) is named so. */
export function confirmCallsText(critical: boolean, single = false): string {
  if (!critical) return translateNow("chat.approval.confirm.calls");
  return translateNow(single ? "chat.approval.confirm.criticalSingle" : "chat.approval.confirm.critical");
}

/** What a grouped round allows, as its card names it: the browser on the hosts its calls open. */
export function roundGroupName(
  group: string,
  round: { readonly requests: readonly { readonly display?: { readonly host?: string | undefined } | undefined }[] },
): string {
  return toolGroupLabel(
    group,
    round.requests.flatMap((request) => (request.display?.host === undefined ? [] : [request.display.host])),
    translateCore,
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
  const t = useT();
  return (
    <>
      {run.run.pending.map((pending) => (
        <section className="round" aria-label={t("chat.approval.required")} key={pending.steps}>
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
  if (decidedBy === "operator") return translateNow("chat.approval.decider.you");
  if (!decidedBy.startsWith("auto:")) return decidedBy;
  return approved === false
    ? translateNow("chat.approval.decider.autoDeny")
    : approved === true
      ? translateNow("chat.approval.decider.autoApprove")
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
  if (request.scopeGroup !== undefined)
    return [translateNow("chat.approval.rule.any", { tool: roundGroupName(request.scopeGroup, { requests: [request] }) })];
  return request.subjects === undefined || request.subjects.length === 0
    ? [translateNow("chat.approval.rule.any", { tool: request.toolName })]
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

/** What a `session` grant's button, its explanation and its tooltip say, where it is made. */
function sessionScopeWords(lastingChat: boolean): {
  readonly allow: UiKey;
  readonly explain: UiKey;
  readonly runsWithout: UiKey;
} {
  return lastingChat
    ? {
        allow: "chat.approval.session.allowLasting",
        explain: "chat.approval.group.explainLasting",
        runsWithout: "chat.approval.session.runsWithoutLasting",
      }
    : { allow: "chat.approval.session.allow", explain: "chat.approval.group.explain", runsWithout: "chat.approval.session.runsWithout" };
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
  const t = useT();
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
        placeholder={t("chat.approval.reason.placeholder")}
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
      ? t("chat.approval.heading.group", { group: roundGroupName(group, round) })
      : round.requests.length === 1
        ? t("chat.approval.heading.one")
        : t("chat.approval.heading.many", { count: round.requests.length });
  return (
    <>
      <p className={group === undefined ? "round-heading meta-sm" : "group-ask"}>
        <span className="visually-hidden">{t("chat.approval.requiredPrefix")}</span>
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
                {t("chat.approval.allowCall")}{" "}
              </label>
            ) : null}
            <CallLine request={request} grouped={group !== undefined} />
          </li>
        ))}
      </ul>
      {round.requests.length > 64 ? <p>{t("chat.approval.tooMany")}</p> : null}
      {rejecting ? (
        <div className="reject-form" ref={rejectForm}>
          {reasonField(t("chat.approval.reason.deny"))}
          <div className="actions">
            <Button variant="destructive" disabled={!ready} onClick={reject}>
              {t("chat.approval.deny")}
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              {t("chat.approval.cancel")}
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
              {t(session.allow)}
            </Button>
            {scopes.includes("once") ? (
              <Button disabled={!approvable} onClick={() => act(true, "once")}>
                {t("chat.approval.allowOnce")}
              </Button>
            ) : null}
            {scopes.includes("always") ? (
              <Button disabled={!approvable} onClick={() => act(true, "always")}>
                {t("chat.approval.alwaysAllow")}
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
              {t("chat.approval.denyMore")}
            </Button>
          </div>
          {/* The buttons first; what they allow, for whoever wants to read it, behind a disclosure. */}
          <details className="approval-explain">
            <summary className="disclosure">{t("chat.approval.group.whatAllows")}</summary>
            <Notice>
              {t(session.explain, { group: roundGroupName(group, round) })}
              {((note) => (note === undefined ? "" : ` ${note}`))(toolGroupScopeNote(group, translateCore))}
              {scopes.includes("always") ? ` ${t("chat.approval.group.explainAlways")}` : ""}
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
            {perCall ? t("chat.approval.allowSelected") : t("chat.approval.allowOnce")}
          </Button>
          {perCall ? (
            <Button
              disabled={!approvable}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              onClick={() => act(true)}
            >
              {t("chat.approval.allowAll")}
            </Button>
          ) : null}
          {scopes.includes("session") && saved.length > 0 ? (
            <Button
              disabled={!approvable}
              title={t(session.runsWithout, { rules: saved.flatMap(ruleSubjects).join("; ") })}
              onClick={() => act(chosen(), "session")}
            >
              {t(session.allow)}
            </Button>
          ) : null}
          {scopes.includes("always") && saved.length > 0 ? (
            <Button
              disabled={!approvable}
              title={t("chat.approval.always.title", { rules: saved.flatMap(ruleSubjects).join("; ") })}
              onClick={() => act(chosen(), "always")}
            >
              {t("chat.approval.alwaysAllow")}
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
            {t("chat.approval.denyMore")}
          </Button>
        </div>
      )}
      {!rejecting && group === undefined && scopes.includes("always") && saved.length > 0 ? (
        <Notice>
          {withParts(t("chat.approval.always.notice"), {
            rules: saved
              .flatMap((request) => ruleSubjects(request).map((subject, index) => ({ key: `${request.callId}:${index}`, subject })))
              .map(({ key, subject }, index) => (
                <Fragment key={key}>
                  {index === 0 ? "" : "; "}
                  <code>{subject}</code>
                </Fragment>
              )),
          })}
        </Notice>
      ) : null}
      {!rejecting && perCall && rejected.length > 0 ? reasonField(t("chat.approval.reason.unchecked")) : null}
      {armed?.signature === signature && ready ? (
        <InlineConfirm
          small={false}
          message={confirmCallsText(round.requests.some((request) => request.risk?.level === "critical"))}
          confirmLabel={t("chat.approval.confirm.button")}
          cancelLabel={t("chat.approval.confirm.back")}
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
      {!ready ? <Notice>{run.deciding === round.steps ? t("chat.approval.deciding") : t("chat.approval.waitingRound")}</Notice> : null}
    </>
  );
}
