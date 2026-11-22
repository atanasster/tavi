import { useEffect, useRef, useState } from "react";

import { TAINTED_CALL_WORDS, approvalChannelLabel, toolCallTitle, type ApprovalScope } from "@tavi/contracts";

import { Failure, InlineConfirm, Pending } from "../../ui/Parts.js";
import { confirmCallsText, REJECT_REASON_MAX } from "../chat/Approvals.js";
import { AppLink } from "../shell/AppLink.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { taskPath } from "../shell/route.js";
import type { loadRoundCalls } from "./approvals-api.js";
import { expiryLabel, scopeButton, type PendingRoundCard } from "./inbox-model.js";
import { Button } from "../../ui/Button.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";
import { spoken, type Said } from "../chat/store/said.js";

/** Where a card stands after the reader acted on it. */
export type CardOutcome =
  | { readonly kind: "busy" }
  | {
      readonly kind: "done";
      readonly approved: boolean;
      readonly scope: ApprovalScope;
      readonly partial?: { readonly approved: number; readonly of: number };
    }
  | { readonly kind: "settled"; readonly text: Said }
  | { readonly kind: "error"; readonly message: string };
/** A round's decision as the card makes it: whole, or per call with the rest rejected; a rejection may say why. */
export interface RoundDecision {
  readonly approved: boolean;
  readonly scope: ApprovalScope;
  readonly decisions?: readonly { readonly callId: string; readonly approved: boolean }[] | undefined;
  readonly note?: string | undefined;
}
type RoundCalls = Awaited<ReturnType<typeof loadRoundCalls>>;
/** One round waiting on the reader, or — once acted on — the line saying how it ended. */
export function RoundCard({
  hidden = false,
  card,
  outcome,
  now,
  person,
  linkTo,
  loadCalls,
  onDecide,
  onOpen,
}: {
  readonly hidden?: boolean;
  readonly card: PendingRoundCard;
  readonly outcome: CardOutcome | undefined;
  readonly now: number;
  readonly person: string | undefined;
  /** The task its "In" line opens; absent, the chat the round belongs to. */
  readonly linkTo?: string | undefined;
  /** The round's calls with their full input, read when Details is opened. */
  readonly loadCalls?: (() => Promise<RoundCalls>) | undefined;
  readonly onDecide: (decision: RoundDecision) => void;
  /** Its "In" link followed in place; absent, the link opens as the browser would. */
  readonly onOpen?: (() => void) | undefined;
}) {
  const t = useT();
  const channels = useChannelNames();
  /** A critical round's approval, held for its second step. */
  const [armed, setArmed] = useState<RoundDecision>();
  /** The calls left unticked, when a round is decided per call. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  /** A rejection's reason, while it is being written; undefined when not rejecting. */
  const [rejecting, setRejecting] = useState<string>();
  const [details, setDetails] = useState<RoundCalls>();
  /** Why the unticked calls are rejected, when a round is decided per call. */
  const [partialReason, setPartialReason] = useState("");
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const single = card.calls.length === 1 ? card.calls[0] : undefined;
  const collapsed = outcome?.kind === "done" || outcome?.kind === "settled";
  const decidedLine = useRef<HTMLParagraphElement>(null);
  // Focus follows the card: to Go back when the confirm opens (not to Confirm,
  // so a repeated Enter cannot run the call), to the line saying how it ended
  // once the button that had it is gone.
  useEffect(() => {
    if (collapsed) decidedLine.current?.focus();
  }, [collapsed]);
  useEffect(() => {
    if (rejecting !== undefined) reasonBox.current?.focus();
  }, [rejecting !== undefined]);
  const what =
    single === undefined ? t("center.roundCard.toolCalls", { count: card.calls.length }) : toolCallTitle(single.toolId, single.summary);
  if (outcome?.kind === "done" || outcome?.kind === "settled") {
    const verdict =
      outcome.kind === "settled"
        ? undefined
        : outcome.partial !== undefined
          ? t("center.roundCard.allowedSome", { count: outcome.partial.approved, of: outcome.partial.of })
          : !outcome.approved
            ? t("center.roundCard.denied")
            : outcome.scope === "session"
              ? card.lastingChat
                ? t("center.roundCard.allowedUntilTomorrow")
                : t("center.roundCard.allowedForChat")
              : outcome.scope === "always"
                ? t("center.roundCard.alwaysAllowed")
                : t("center.roundCard.allowedOnce");
    return (
      <li className="center-card center-card-decided" hidden={hidden}>
        <p className="center-decided" role="status" tabIndex={-1} ref={decidedLine}>
          {verdict === undefined ? (
            <span>{outcome.kind === "settled" ? spoken(outcome.text, t) : null}</span>
          ) : (
            <span
              className={
                outcome.kind === "done" && outcome.approved
                  ? "center-verdict center-verdict-approved"
                  : "center-verdict center-verdict-rejected"
              }
            >
              {t("center.roundCard.justNow", { verdict })}
            </span>
          )}
          <span className="center-decided-what">{what}</span>
        </p>
      </li>
    );
  }
  const busy = outcome?.kind === "busy";
  // A lone call titled by its tool alone names it in the heading: its chip would say it twice.
  const tools = single !== undefined && what === single.toolId ? [] : [...new Set(card.calls.map((call) => call.toolId))];
  const partial = single === undefined && unticked.size > 0;
  const approve = (scope: ApprovalScope): void => {
    // Some calls unticked: those approved once, the rest rejected.
    const decision: RoundDecision = partial
      ? {
          approved: unticked.size < card.calls.length,
          scope: "once",
          decisions: card.calls.map((call) => ({ callId: call.callId, approved: !unticked.has(call.callId) })),
          note: partialReason.trim(),
        }
      : { approved: true, scope };
    // As the task's card (`needsSecondStep`): critical risk confirms, and so
    // does a round with no risk recorded, since the inbox cannot tell a
    // read-only call from one that changes something.
    if (card.risk === undefined || card.risk === "critical") setArmed(decision);
    else onDecide(decision);
  };
  const toggleCall = (callId: string): void => {
    // What a confirm step holds is what was ticked when it opened: a change
    // takes it back, so a call unticked now is never approved by it.
    setArmed(undefined);
    setUnticked((held) => {
      const next = new Set(held);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };
  /** While a confirm or a reason is open, the ticks it was opened for hold still. */
  const choosing = armed !== undefined || rejecting !== undefined;
  const openDetails = (): void => {
    if (details !== undefined || loadCalls === undefined) return;
    void loadCalls().then(setDetails);
  };
  return (
    <li
      className={card.risk === undefined ? "center-card" : `center-card center-card-${card.risk}`}
      aria-label={t("center.roundCard.label", { what })}
      hidden={hidden}
      tabIndex={-1}
    >
      <div className="center-card-top">
        {tools.map((tool) => (
          <code key={tool} className="center-tool">
            {tool}
          </code>
        ))}
        {card.risk === undefined ? null : <span className="center-risk-tag eyebrow">{t(`center.roundCard.risk.${card.risk}`)}</span>}
        {card.announcedIn === undefined ? null : (
          <span className="center-card-note meta">
            {t("center.roundCard.askedIn", {
              channel: card.announcedIn.channel ?? approvalChannelLabel(card.announcedIn.connectionId, channels.connection),
            })}
          </span>
        )}
        {card.expiresAt === undefined ? null : (
          <time className="center-expires meta" dateTime={card.expiresAt}>
            {expiryLabel(card.expiresAt, now)}
          </time>
        )}
      </div>
      <h3>{single === undefined ? t("center.roundCard.waitTogether", { count: card.calls.length }) : what}</h3>
      {card.provenance === undefined ? null : (
        <p className="center-card-provenance meta">
          {/[.!?]$/.test(card.provenance) ? card.provenance : `${card.provenance}.`}
          <span className="center-card-why"> {TAINTED_CALL_WORDS}</span>
        </p>
      )}
      {single === undefined ? (
        <ul className="center-card-calls list-reset" aria-label={t("center.roundCard.callsLabel")}>
          {card.calls.map((call) => (
            <li key={call.approvalId}>
              <label>
                <input
                  type="checkbox"
                  checked={!unticked.has(call.callId)}
                  disabled={busy || choosing}
                  onChange={() => toggleCall(call.callId)}
                />
                <code className="center-tool">{call.toolId}</code> {call.summary ?? null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {partial && !choosing ? (
        <label className="center-reason">
          {t("center.roundCard.whyDenyUnticked")}
          <textarea
            value={partialReason}
            maxLength={REJECT_REASON_MAX}
            rows={2}
            disabled={busy}
            onChange={(event) => setPartialReason(event.target.value)}
          />
        </label>
      ) : null}
      {loadCalls === undefined ? null : (
        <details
          className="center-card-details"
          onToggle={(event) => {
            if ((event.currentTarget as HTMLDetailsElement).open) openDetails();
          }}
        >
          <summary className="disclosure">{t("center.roundCard.details")}</summary>
          {details === undefined || !details.ok ? (
            <Pending error={details?.ok === false ? details.message : undefined} className="notice" status />
          ) : (
            details.value
              .filter((call) => call.steps === card.steps && card.calls.some((listed) => listed.callId === call.callId))
              .map((call) => (
                <div key={call.callId} className="center-card-call">
                  <p>
                    <code className="center-tool">{call.toolId}</code> <span className="center-card-note meta">{call.state}</span>
                  </p>
                  <pre>{inputText(call.inputs)}</pre>
                </div>
              ))
          )}
        </details>
      )}
      <p className="center-card-ctx meta">
        {withParts(t("center.roundCard.in"), {
          chat: (
            <AppLink href={taskPath(linkTo ?? card.chatTaskId)} onFollow={onOpen}>
              {card.taskTitle ?? card.taskId}
            </AppLink>
          ),
        })}
        {person === undefined ? null : <> · {person}</>}
      </p>
      {rejecting !== undefined ? (
        <div className="confirmation">
          <label className="center-reason">
            {t("center.roundCard.whyDeny")}
            <textarea
              ref={reasonBox}
              value={rejecting}
              maxLength={REJECT_REASON_MAX}
              rows={2}
              onChange={(event) => setRejecting(event.target.value)}
            />
          </label>
          <div className="actions">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                onDecide({ approved: false, scope: "once", note: rejecting.trim() });
                setRejecting(undefined);
              }}
            >
              {t("center.roundCard.deny")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(undefined)}>
              {t("center.roundCard.goBack")}
            </Button>
          </div>
        </div>
      ) : armed !== undefined ? (
        <InlineConfirm
          focusCancel
          message={confirmCallsText(card.risk === "critical", single !== undefined)}
          confirmLabel={t("center.roundCard.confirmAndRun")}
          cancelLabel={t("center.roundCard.goBack")}
          busy={busy}
          onConfirm={() => {
            onDecide(armed);
            setArmed(undefined);
          }}
          onCancel={() => setArmed(undefined)}
        />
      ) : (
        <div className="center-card-actions">
          {partial ? (
            <Button variant="primary" size="sm" disabled={busy || unticked.size === card.calls.length} onClick={() => approve("once")}>
              {t("center.roundCard.allowTicked")}
            </Button>
          ) : (
            card.allowedScopes.map((scope, index) => (
              <Button
                key={scope}
                variant={index === 0 ? "primary" : undefined}
                size="sm"
                disabled={busy}
                onClick={() => approve(scope)}
                {...(scope === "session"
                  ? {
                      title: card.lastingChat ? t("center.roundCard.sessionLastingTitle") : t("center.roundCard.sessionTitle"),
                    }
                  : {})}
              >
                {scopeButton(scope, card.lastingChat)}
              </Button>
            ))
          )}
          <Button variant="danger-ghost" size="sm" disabled={busy} onClick={() => setRejecting("")}>
            {t("center.roundCard.denyEllipsis")}
          </Button>
          {busy ? (
            <span className="center-card-note meta" role="status">
              {t("center.roundCard.deciding")}
            </span>
          ) : null}
        </div>
      )}
      {card.allowedScopes.includes("always") && armed === undefined ? (
        <p className="center-card-hint meta">{t("center.roundCard.alwaysHint")}</p>
      ) : null}
      {outcome?.kind === "error" ? <Failure>{outcome.message}</Failure> : null}
    </li>
  );
}
/** A call's input as the details show it: formatted, and bounded so one huge input cannot flood the page — saying what it left out. */
function inputText(input: unknown): string {
  const text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  // Cut, it says so and by how much: the hidden part could be what matters.
  return text.length > INPUT_SHOWN_CHARS
    ? `${text.slice(0, INPUT_SHOWN_CHARS)}\n${translateNow("center.roundCard.inputCut", { count: text.length - INPUT_SHOWN_CHARS })}`
    : text;
}
/** How much of one call's input Details shows. */
const INPUT_SHOWN_CHARS = 4_000;
