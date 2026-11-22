import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  IPC_MAX_PROMPT_CHARS,
  approvalChannelLabel,
  isLocalConnectionId,
  type AskUserChoices,
  type NeedDelivery,
  type PendingQuestionRow,
} from "@tavi/contracts";
import type { SettledWait } from "@tavi/client/browser";

import { instantLabel, localDate, localTime, longDay, todayIn, durationText, when as whenLabel } from "../../lib/time.js";
import { usePoll } from "../../hooks/use-poll.js";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { listed } from "../../lib/format.js";
import { withParts } from "../../ui/with-parts.js";
import { said, spoken, type Said } from "../chat/store/said.js";
import type { UiKey } from "../../locales/en.js";
import { Icon } from "../../ui/Icon.js";
import { isBareKeyOutsideText } from "../shell/keys.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";

/**
 * A question a task asks a person, as one card wherever it is shown — the
 * transcript, the inbox, the chat panel, a routine's run. Context before controls: who asks, what, why, and what happens
 * without an answer; then the options. Once answered, expired or withdrawn it
 * becomes a one-line receipt (`QuestionReceipt`) rather than vanishing.
 */

/** What the card shows of a question. */
export interface QuestionNeed {
  readonly question: string;
  readonly choices?: AskUserChoices | undefined;
  /** Why it is asked. */
  readonly context?: string | undefined;
  readonly deadlineAt: string;
  /** When it was asked, so urgency is read against the whole window; absent, only the last five minutes are urgent. */
  readonly askedAt?: string | undefined;
  /** Who asks: the task's or routine's name. */
  readonly askedBy?: string | undefined;
  /** The chats it was also sent to, by name. */
  readonly channels?: readonly string[] | undefined;
}

/** Where the person's own answer stands, from this front end. */
export interface AnswerState {
  readonly status: "sending" | "recorded" | "uncertain" | "failed";
  readonly text: string;
  /** The page's own message as a key (said where it is shown), or the owner's text. */
  readonly message?: Said | undefined;
}

/** What a refused answer says when the question had already closed. */
export const ANSWERED_ELSEWHERE_KEY: UiKey = "needs.card.answeredElsewhere";

/**
 * A pending question as the card shows it. `channelOf` names each chat it was
 * sent to (absent, they are not listed), but this computer's own: the card is
 * already where that one is asked. `askedBy`, who asks.
 */
export function questionNeed(row: PendingQuestionRow, channelOf?: (delivery: NeedDelivery) => string, askedBy?: string): QuestionNeed {
  return {
    question: row.question,
    choices: row.choices,
    context: row.context,
    deadlineAt: row.deadlineAt,
    askedAt: row.askedAt,
    ...(askedBy === undefined ? {} : { askedBy }),
    ...(channelOf === undefined
      ? {}
      : { channels: row.deliveries.filter((delivery) => !isLocalConnectionId(delivery.connectionId)).map(channelOf) }),
  };
}

/** A chat a question was sent to, by the name the owner gave it, else its connection. */
export const deliveryName = (delivery: NeedDelivery): string => delivery.channel ?? delivery.connectionId;

/** Where an answer stands once the owner answered: recorded, closed before it arrived, or refused. */
export function answerOutcome(
  text: string,
  outcome: { readonly ok: true } | { readonly ok: false; readonly message: string; readonly code?: string },
): AnswerState {
  if (outcome.ok) return { status: "recorded", text };
  return outcome.code === "CONFLICT"
    ? { status: "uncertain", text, message: said(ANSWERED_ELSEWHERE_KEY) }
    : { status: "failed", text, message: outcome.message };
}

/** An answer sent from here, as the card shows it. */
export function sentAnswer(
  sent: { readonly status: AnswerState["status"]; readonly text: string; readonly message?: Said | undefined } | undefined,
): AnswerState | undefined {
  return sent === undefined
    ? undefined
    : { status: sent.status, text: sent.text, ...(sent.message === undefined ? {} : { message: sent.message }) };
}

/** Whether the send shortcut is ⌘ (a Mac) or Ctrl. */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** How long a click on an option waits for an Undo before it is sent. */
const UNDO_MS = 4_000;

const MINUTE = 60_000;
/** The deadline turns urgent in its last tenth, or its last five minutes. */
const URGENT_FLOOR_MS = 5 * MINUTE;

/** Whether a question is in its last five minutes at `now`: when it is said once more, aloud. */
export function inLastMinutes(deadlineAt: string, now: number): boolean {
  const left = Date.parse(deadlineAt) - now;
  return left > 0 && left <= URGENT_FLOOR_MS;
}

/** What is said aloud when a question's last five minutes begin. */
export const lastMinutesSentence = (question: string): string => translateNow("needs.card.lastMinutes", { question });

/**
 * "Answer by 14:30 · 25 min", read against `now` in the workspace's
 * `timeZone` (the day too, when it is not today); urgent near the end, past after.
 */
export function deadlineLabel(
  deadlineAt: string,
  now: number,
  timeZone: string | undefined,
  askedAt?: string,
): { readonly text: string; readonly urgent: boolean; readonly past: boolean; readonly title: string } {
  const at = Date.parse(deadlineAt);
  if (Number.isNaN(at)) return { text: "", urgent: false, past: false, title: "" };
  const today = todayIn(timeZone, now);
  const when = instantLabel(deadlineAt, timeZone, today);
  const title = `${longDay(localDate(deadlineAt, timeZone), today)} ${localTime(deadlineAt, timeZone)}${timeZone === undefined ? "" : ` (${timeZone})`}`;
  const left = at - now;
  if (left <= 0) return { text: translateNow("needs.card.wasDue", { when }), urgent: false, past: true, title };
  const asked = askedAt === undefined ? Number.NaN : Date.parse(askedAt);
  // Without when it was asked, only the last minutes are urgent.
  const urgent = left <= URGENT_FLOOR_MS || (!Number.isNaN(asked) && left <= (at - asked) / 10);
  return {
    text: translateNow("needs.card.answerBy", { when, left: durationText(left, { seconds: true, days: true }) }),
    urgent,
    past: false,
    title,
  };
}

/**
 * The labels an answer names: a multi-select is sent as the options' numbers
 * ("1, 3"), and a receipt shows their labels. Anything else is itself.
 */
export function answerLabels(text: string, choices: AskUserChoices | undefined): string {
  if (choices === undefined || !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(text)) return text;
  const labels = text.split(",").map((part) => choices.options[Number(part.trim()) - 1]?.label);
  return labels.every((label): label is string => label !== undefined) ? labels.join(", ") : text;
}

/** Re-renders on a cadence: each second in the last two minutes, each half minute before. */
function useDeadlineClock(deadlineAt: string, now: () => number): number {
  const [current, setCurrent] = useState(now);
  const left = Date.parse(deadlineAt) - current;
  usePoll(() => setCurrent(now()), left < 2 * MINUTE ? 1_000 : 30_000, { enabled: left > 0 }, [now]);
  return current;
}

export function QuestionCard({
  need,
  answer,
  blocked,
  onAnswer,
  density = "full",
  undoMs = UNDO_MS,
  now = Date.now,
  announce = false,
  onDropped,
  timeZone,
}: {
  readonly need: QuestionNeed;
  readonly answer?: AnswerState | undefined;
  /** Why it cannot be answered now, and where to go to unblock it. */
  readonly blocked?: { readonly reason: string; readonly jump?: (() => void) | undefined } | undefined;
  readonly onAnswer: (text: string) => void;
  readonly density?: "full" | "compact";
  readonly undoMs?: number;
  readonly now?: () => number;
  /**
   * Say, through the card's own status, when the last five minutes begin. Off
   * where the page's one announcer already says it (the chat, its panel).
   */
  readonly announce?: boolean;
  /**
   * The card went away with a pick still in its undo window — the question
   * was answered elsewhere, or closed — so that pick was never sent.
   */
  readonly onDropped?: ((label: string) => void) | undefined;
  /** The workspace's zone, the one the deadline is said in. */
  readonly timeZone: string | undefined;
}) {
  const t = useT();
  const headingId = useId();
  const contextId = useId();
  const choices = need.choices;
  const [pending, setPending] = useState<number>();
  const [picks, setPicks] = useState<readonly number[]>([]);
  const [text, setText] = useState("");
  const [ownWords, setOwnWords] = useState(choices === undefined);
  const options = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const ownWordsArea = useRef<HTMLTextAreaElement>(null);
  /** Set when the person opened own words, so the box takes focus then and not on mount. */
  const [focusOwnWords, setFocusOwnWords] = useState(false);
  const current = useDeadlineClock(need.deadlineAt, now);
  const deadline = deadlineLabel(need.deadlineAt, current, timeZone, need.askedAt);
  const busy = answer !== undefined && answer.status !== "failed";
  const disabled = blocked !== undefined || busy;
  const fallback = choices?.defaultOption === undefined ? undefined : choices.options[choices.defaultOption - 1]?.label;

  // A card blocked while an option waits to be sent — an approval came first,
  // the connection dropped — takes the choice back rather than lose it silently.
  useResetOnChange([disabled], () => {
    if (disabled) setPending(undefined);
  });
  useEffect(() => {
    if (focusOwnWords) ownWordsArea.current?.focus();
  }, [focusOwnWords, ownWords]);

  // Read when the card goes: a pick still waiting then is one that was never sent.
  const unsent = useRef({ label: undefined as string | undefined, onDropped });
  unsent.current = { label: pending === undefined ? undefined : choices?.options[pending]?.label, onDropped };
  useEffect(
    () => () => {
      const { label, onDropped: dropped } = unsent.current;
      if (label !== undefined) dropped?.(label);
    },
    [],
  );

  // A clicked option is sent once the undo window passes, unless taken back.
  useEffect(() => {
    if (pending === undefined) return;
    const label = choices?.options[pending]?.label;
    const timer = setTimeout(() => {
      setPending(undefined);
      if (label !== undefined) onAnswer(label);
    }, undoMs);
    return () => clearTimeout(timer);
  }, [pending]);

  const sendNow = (index: number) => {
    setPending(undefined);
    const label = choices?.options[index]?.label;
    if (label === undefined || disabled) return;
    onAnswer(label);
    // The option buttons go quiet while it is sent; focus stays in the card.
    heading.current?.focus();
  };
  const undo = (index: number) => {
    setPending(undefined);
    options.current[index]?.focus();
  };
  const openOwnWords = () => {
    setOwnWords(true);
    setFocusOwnWords(true);
  };
  const sendPicks = () => {
    if (picks.length > 0)
      onAnswer(
        [...picks]
          .sort((a, b) => a - b)
          .map((index) => String(index + 1))
          .join(", "),
      );
  };
  const sendText = () => {
    const trimmed = text.trim();
    if (trimmed !== "") onAnswer(trimmed);
  };
  const toggle = (index: number) =>
    setPicks((current) => (current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index]));

  // Number keys pick an option, `o` opens own words — never while typing.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || choices === undefined || !isBareKeyOutsideText(event)) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.options.length) {
      event.preventDefault();
      if (choices.multiSelect) toggle(index);
      options.current[index]?.focus();
      return;
    }
    if (event.key === "o" && choices.allowOther) {
      event.preventDefault();
      openOwnWords();
    }
  };

  if (answer?.status === "recorded") {
    return (
      <p className={`need-receipt need-receipt-answered${density === "compact" ? " need-compact" : ""}`} role="status">
        <Icon name="check" size="sm" />{" "}
        {withParts(t("needs.receipt.youAnswered"), { answer: <strong>{answerLabels(answer.text, choices)}</strong> })}
        <span className="need-receipt-meta"> · {t("needs.card.waitingForChat")}</span>
      </p>
    );
  }

  const pendingLabel = pending === undefined ? undefined : choices?.options[pending]?.label;
  // Said once, when the last five minutes begin — never a second-by-second countdown.
  const lastMinutes = inLastMinutes(need.deadlineAt, current);
  const footerNotes = [
    ...(fallback === undefined
      ? []
      : [<span key="default">{withParts(t("needs.card.ifNobody"), { option: <strong>{fallback}</strong> })}</span>]),
    ...(need.channels === undefined || need.channels.length === 0
      ? []
      : [<span key="channels">{t("needs.card.alsoAsked", { channels: listed(need.channels) })}</span>]),
  ];
  return (
    <section
      className={`need need-question${density === "compact" ? " need-compact" : ""}`}
      role="group"
      aria-labelledby={headingId}
      aria-describedby={need.context === undefined ? undefined : contextId}
      onKeyDown={onKeyDown}
    >
      <div className="need-meta">
        <span className="need-kind">
          <Icon name="question" size="sm" /> {choices?.header ?? t("needs.card.question")}
          {need.askedBy === undefined ? null : <span className="need-asker"> · {need.askedBy}</span>}
        </span>
        {deadline.text === "" ? null : (
          <time
            className={`need-deadline${deadline.urgent ? " need-deadline-urgent" : ""}${deadline.past ? " need-deadline-past" : ""}`}
            dateTime={need.deadlineAt}
            title={deadline.title}
          >
            {deadline.text}
          </time>
        )}
      </div>
      <h3 className="need-question-text" id={headingId} ref={heading} tabIndex={-1}>
        {need.question}
      </h3>
      {need.context === undefined ? null : (
        <p className="need-context meta-base" id={contextId}>
          {t("needs.card.why", { context: need.context })}
        </p>
      )}

      {choices === undefined ? null : (
        <div className="need-options" role="group" aria-label={choices.multiSelect ? t("needs.card.optionsAny") : t("needs.card.options")}>
          {choices.options.map((option, index) => {
            const recommended = choices.recommended === index + 1;
            const descriptionId = `${headingId}-option-${index}`;
            const body = (
              <>
                <span className="need-option-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="need-option-text">
                  <span className="need-option-label">{option.label}</span>
                  {option.description === undefined ? null : (
                    <span className="need-option-description meta-base" id={descriptionId}>
                      {option.description}
                    </span>
                  )}
                </span>
                {recommended ? (
                  <span className="need-option-tag">
                    <Icon name="star" size="sm" /> {t("needs.card.recommended")}
                  </span>
                ) : null}
              </>
            );
            return choices.multiSelect ? (
              <label key={option.label} className={`need-option${picks.includes(index) ? " need-option-picked" : ""}`}>
                <input
                  type="checkbox"
                  checked={picks.includes(index)}
                  disabled={disabled}
                  onChange={() => toggle(index)}
                  ref={(element) => {
                    options.current[index] = element;
                  }}
                  {...(option.description === undefined ? {} : { "aria-describedby": descriptionId })}
                />
                {body}
              </label>
            ) : (
              <Button
                key={option.label}
                variant="bare"
                className={`need-option${pending === index ? " need-option-picked" : ""}`}
                disabled={disabled || (pending !== undefined && pending !== index)}
                {...(option.description === undefined ? {} : { "aria-describedby": descriptionId })}
                ref={(element) => {
                  options.current[index] = element;
                }}
                onClick={() => setPending(index)}
                // A keyboard choice is already deliberate: sent at once.
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (!disabled) sendNow(index);
                }}
              >
                {body}
              </Button>
            );
          })}
        </div>
      )}

      {pendingLabel === undefined || pending === undefined ? null : (
        <div className="need-undo" role="status">
          <span>{withParts(t("needs.card.sendingPick"), { option: <strong>{pendingLabel}</strong> })}</span>
          <Button variant="ghost" size="sm" onClick={() => undo(pending)}>
            {t("needs.card.undo")}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => sendNow(pending)}>
            {t("needs.card.sendNow")}
          </Button>
          <span className="need-undo-bar" aria-hidden="true" style={{ animationDuration: `${undoMs}ms` }} />
        </div>
      )}

      {choices !== undefined && !choices.allowOther ? null : ownWords || choices === undefined ? (
        <div className="need-own">
          <label>
            {choices === undefined ? t("needs.card.yourAnswer") : t("needs.card.ownWords")}
            <textarea
              ref={ownWordsArea}
              value={text}
              maxLength={IPC_MAX_PROMPT_CHARS}
              disabled={disabled}
              rows={2}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (!disabled) sendText();
                }
              }}
            />
          </label>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="need-own-open" disabled={disabled} onClick={openOwnWords}>
          <Icon name="plus" size="sm" /> {t("needs.card.answerOwnWords")}
        </Button>
      )}

      {footerNotes.length === 0 && choices?.multiSelect !== true && !(ownWords || choices === undefined) ? null : (
        <div className="need-footer">
          {footerNotes.length === 0 ? <span /> : <div className="need-footer-notes meta-sm">{footerNotes}</div>}
          {choices?.multiSelect === true ? (
            <Button variant="primary" size="sm" disabled={disabled || picks.length === 0} onClick={sendPicks}>
              {picks.length === 0 ? t("needs.card.pickSome") : t("needs.card.sendChoices", { count: picks.length })}
            </Button>
          ) : ownWords || choices === undefined ? (
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || text.trim() === ""}
              onClick={sendText}
              aria-keyshortcuts={MAC ? "Meta+Enter" : "Control+Enter"}
            >
              {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the kbd is not focusable; the button states the shortcut in aria-keyshortcuts */}
              {withParts(t("needs.card.send"), { key: <kbd aria-hidden="true">{MAC ? "⌘⏎" : "Ctrl+Enter"}</kbd> })}
            </Button>
          ) : null}
        </div>
      )}

      {announce ? (
        <span className="visually-hidden" role="status">
          {lastMinutes && !busy ? lastMinutesSentence(need.question) : ""}
        </span>
      ) : null}
      {blocked === undefined ? null : (
        <Notice className="need-blocked">
          {blocked.reason}
          {blocked.jump === undefined ? null : (
            <>
              {" "}
              <Button variant="ghost" size="sm" onClick={blocked.jump}>
                {t("needs.card.goToIt")}
              </Button>
            </>
          )}
        </Notice>
      )}
      {answer?.status === "sending" ? (
        <p className="need-status" role="status">
          {t("needs.card.sendingAnswer")}
        </p>
      ) : null}
      {answer?.status === "uncertain" ? (
        <Notice role="status">
          {answer.message === undefined ? t("needs.card.mayBeRecorded") : spoken(answer.message, t)} {t("needs.card.keepFollowing")}
        </Notice>
      ) : null}
      {answer?.status === "failed" ? (
        <Failure>
          {answer.message === undefined ? t("needs.card.notSent") : spoken(answer.message, t)}{" "}
          <Button size="sm" disabled={blocked !== undefined} onClick={() => onAnswer(answer.text)}>
            {t("ui.parts.retry")}
          </Button>
        </Failure>
      ) : null}
    </section>
  );
}

/**
 * A settled question, in one line: who answered what through which channel,
 * or that it expired (and what the task went with) or was withdrawn.
 * `self` names the front end this is, so its own answers read as "You".
 */
export function QuestionReceipt({
  receipt,
  timeZone,
  self = "bridge",
  density = "full",
}: {
  readonly receipt: SettledWait;
  readonly timeZone: string | undefined;
  readonly self?: string;
  readonly density?: "full" | "compact";
}) {
  const t = useT();
  const channels = useChannelNames();
  const when = whenLabel(receipt.at, timeZone);
  const answer = receipt.answers !== undefined && receipt.answers.length > 0 ? listed(receipt.answers) : (receipt.replyText ?? "");
  const compact = density === "compact" ? " need-compact" : "";
  if (receipt.outcome === "answered" || receipt.outcome === "replied") {
    const strong = { answer: <strong>{answer}</strong> };
    const said =
      receipt.via === self
        ? withParts(t("needs.receipt.youAnswered"), strong)
        : withParts(t("needs.receipt.answered", { who: receipt.decidedBy ?? t("needs.receipt.someone") }), strong);
    const via =
      receipt.via === undefined || receipt.via === self
        ? ""
        : ` ${t("needs.receipt.via", { channel: approvalChannelLabel(receipt.via, channels.connection, translateCore) })}`;
    return (
      <p className={`need-receipt need-receipt-answered${compact}`}>
        <Icon name="check" size="sm" /> {said}
        <span className="need-receipt-meta">
          {via} · {when}
        </span>
        {receipt.question === undefined ? null : <span className="visually-hidden"> — {receipt.question}</span>}
      </p>
    );
  }
  if (receipt.outcome === "wait-timeout") {
    return (
      <p className={`need-receipt need-receipt-expired${compact}`}>
        <Icon name="hourglass" size="sm" />{" "}
        {answer === "" || receipt.answers === undefined
          ? t("needs.receipt.expiredNone", { when })
          : withParts(t("needs.receipt.expiredWent", { when }), { answer: <strong>{listed(receipt.answers)}</strong> })}
      </p>
    );
  }
  return (
    <p className={`need-receipt need-receipt-withdrawn${compact}`}>
      <Icon name="circle-x" size="sm" /> {t("needs.receipt.withdrawn", { when })}
    </p>
  );
}
