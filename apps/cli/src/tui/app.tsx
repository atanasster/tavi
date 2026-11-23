import { Box, Static, Text, useApp, useInput, usePaste, useStdout } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import { mayBecomeCommand, runnable } from "./commands.js";
import { looksLikeCredential } from "./forms.js";
import { type ChatLine, type ChatStore, type ChatView, unbrokenWidth } from "./store.js";
import { BLINK_CURSOR, GLYPHS, TONES, UI_TONES } from "./theme.js";
import type { ApprovalScope } from "@tavi/contracts";

/**
 * The chat TUI: the committed transcript in `<Static>`,
 * printed once into the terminal's scrollback, and one live region below it —
 * the unfinished line, the status and the prompt — which the store keeps
 * shorter than the viewport. The tree holds no transcript state of its own:
 * it renders the store's view, which changes at most once a frame.
 */

/** Rows the live region draws below the live rows: the status and the prompt. */
export const RESERVED_ROWS = 2;

export interface ChatAppProps {
  readonly store: ChatStore;
  /** The prompt's first text (`tavi chat --draft`): shown to edit, sent only on Enter. */
  readonly draft?: string;
  /** Absent: no prompt (a replay). */
  readonly onSubmit?: (prompt: string) => void;
  /** The round the view offers, decided whole: `y` approves it, `n` rejects it. */
  /** A round's decision, from its keys: the round whole, with a scope or a reason. */
  readonly onDecide?: (decision: {
    readonly taskId: string;
    readonly steps: number;
    readonly approved: boolean;
    /** An approval's scope; absent means once. */
    readonly scope?: ApprovalScope;
    /** A rejection's reason, which the model reads. */
    readonly note?: string;
  }) => void;
  /** Esc: abort the turn the task is running. */
  readonly onAbort?: (taskId: string) => void;
  /** The review the view offers, for every flagged artifact at once: `y` releases them and resumes, `n` rejects them. */
  readonly onReview?: (review: {
    readonly taskId: string;
    readonly steps: number;
    readonly artifactIds: readonly string[];
    readonly approved: boolean;
  }) => void;
  /** The form being filled: Enter answers its field with what was typed, Esc cancels it. */
  readonly onForm?: { readonly enter: (typed: string) => void; readonly cancel: () => void };
  /** Plugins' slash commands' names as last listed: typed as the chat's own are, while a round or review is offered. */
  readonly pluginCommands?: () => readonly string[];
}

/** How many bullets a secret being typed shows: its length, up to a row's worth. */
const MASK_MAX = 40;

/** Pasted or typed line breaks, as a prompt holds them: one line. */
const oneLine = (text: string): string => text.replace(/\r\n?|\n/g, " ");

/** Bullets for `text`: a secret, or what has a credential's shape, is never drawn. */
const masked = (text: string): string => GLYPHS.masked.repeat(Math.min([...text].length, MASK_MAX));

/**
 * What a key typed at an offer means, in every language the chat speaks: `y`
 * or `д` (да) yes, `n` or `н` (не) no; for a round, `s` or `ч` (чат) for the
 * rest of the chat, `a` or `в` (винаги) always, and `N` or `Н` a rejection
 * with a reason. A Bulgarian key means exactly what its English twin does, so
 * it never approves more than that key would; both work whatever the
 * workspace's language, as a keyboard may be on either layout.
 */
const KEY_MEANINGS: Readonly<Record<string, "yes" | "no" | "session" | "always" | "reason">> = {
  y: "yes",
  Y: "yes",
  д: "yes",
  Д: "yes",
  n: "no",
  н: "no",
  s: "session",
  ч: "session",
  a: "always",
  в: "always",
  N: "reason",
  Н: "reason",
};

/** A key's meaning, from this object's own keys alone (`Object.hasOwn`, so `constructor` means nothing). */
const meaningOf = (key: string): (typeof KEY_MEANINGS)[string] | undefined =>
  Object.hasOwn(KEY_MEANINGS, key) ? KEY_MEANINGS[key] : undefined;

/**
 * Keys typed fast arrive as one chunk: each is a key, and the first yes or no
 * answers what is offered — read afresh before each, so the second of two
 * keys finds the offer gone. Either case answers (`Y`, `N`, `Д`, `Н`).
 */
function answerWith<T>(typed: string, offered: () => T | undefined, answer: (offer: T, approved: boolean) => void): void {
  for (const key of typed.toLowerCase()) {
    const offer = offered();
    if (offer === undefined) return;
    const meaning = meaningOf(key);
    if (meaning === "yes" || meaning === "no") answer(offer, meaning === "yes");
  }
}

/**
 * A round's keys, read case-sensitively: `y` once, `s` for the rest of
 * the task and `a` always where every call offers it, `n` rejects, and `N`
 * asks for a reason first — and their Bulgarian twins (`KEY_MEANINGS`). Like
 * `answerWith`, the offer is read afresh per key.
 */
function answerRound(
  typed: string,
  offered: () => NonNullable<ChatView["decision"]> | undefined,
  answer: (offer: NonNullable<ChatView["decision"]>, verdict: { readonly approved: boolean; readonly scope?: ApprovalScope }) => void,
  askReason: (offer: NonNullable<ChatView["decision"]>, rest: string) => void,
): void {
  const keys = [...typed];
  for (const [index, key] of keys.entries()) {
    const offer = offered();
    if (offer === undefined) return;
    const meaning = meaningOf(key);
    if (meaning === "yes") answer(offer, { approved: true });
    else if (meaning === "session" && offer.scopes.includes("session")) answer(offer, { approved: true, scope: "session" });
    else if (meaning === "always" && offer.scopes.includes("always")) answer(offer, { approved: true, scope: "always" });
    else if (meaning === "no") answer(offer, { approved: false });
    else if (meaning === "reason") {
      // Whatever followed in the same chunk is the reason's start.
      askReason(offer, keys.slice(index + 1).join(""));
      return;
    }
  }
}

export function ChatApp({
  store,
  draft,
  onSubmit,
  onDecide,
  onAbort,
  onReview,
  onForm,
  pluginCommands = () => [],
}: ChatAppProps): ReactElement {
  // A rejection whose reason is being typed: every key is the reason's until Enter or Esc.
  const reasonFor = useRef<NonNullable<ChatView["decision"]> | undefined>(undefined);
  const view = useSyncExternalStore(store.subscribe, store.view);
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  // The typed text lives in a ref as well as in state: one input chunk can
  // carry several key events, dispatched before React commits the first.
  const buffer = useRef(draft ?? "");
  const [input, setInput] = useState(draft ?? "");
  const [exiting, setExiting] = useState(false);
  const { exit } = useApp();
  useEffect(() => {
    if (exiting) exit();
  }, [exiting, exit]);
  const set = (next: string): void => {
    buffer.current = next;
    setInput(next);
  };
  // The store's own flag, not the last frame's: a second Enter within a frame
  // of the first must not start a second run.
  // Typing starts a run, answers the question the task waits on, or — while a
  // turn runs with nothing to decide — queues a prompt behind it.
  const accepting = (): boolean =>
    onSubmit !== undefined &&
    (!store.running || store.answerNow() !== undefined || (store.decisionNow() === undefined && store.reviewNow() === undefined));
  // An answer being typed whose question went away — answered elsewhere, or
  // past its deadline — is dropped, not kept to become the next run's prompt.
  const offered = useRef(view.answer);
  useEffect(() => {
    // A form being filled keeps what is typed: the question going is no part of it.
    const keep = mayBecomeCommand(buffer.current, pluginCommands()) || store.formNow() !== undefined;
    if (offered.current !== undefined && view.answer === undefined && store.running && !keep) set("");
    offered.current = view.answer;
  }, [view.answer]);
  const submit = (): void => {
    const prompt = buffer.current.trim();
    if (prompt === "" || onSubmit === undefined) return;
    set("");
    onSubmit(prompt);
  };
  // A command (`/agents`…) is typed whenever there is a prompt — a run going,
  // a round offered. While nothing else takes the prompt, whatever starts with
  // `/` is the command's: its longest prefix of one is kept, the rest dropped,
  // so no key of it is ever a y or an n; Enter runs it only once it is whole.
  const commandGoing = (): boolean => onSubmit !== undefined && buffer.current !== "" && mayBecomeCommand(buffer.current, pluginCommands());
  const takesCommand = (text: string): boolean =>
    onSubmit !== undefined && !accepting() && (commandGoing() || (buffer.current === "" && text.startsWith("/")));
  const typeCommand = (text: string, entered: boolean): void => {
    const plugins = pluginCommands();
    let next = buffer.current;
    for (const character of text) {
      if (!mayBecomeCommand(next + character, plugins)) break;
      next += character;
    }
    set(next);
    if (entered && runnable(next, plugins)) submit();
  };
  const filling = (): boolean => onForm !== undefined && store.formNow() !== undefined;
  /** Backspace (or Delete) erases the last character typed; `true` when the key was one. */
  const erased = (key: { readonly backspace: boolean; readonly delete: boolean }): boolean => {
    if (!key.backspace && !key.delete) return false;
    set([...buffer.current].slice(0, -1).join(""));
    return true;
  };

  usePaste(
    (text) => {
      // Into a form's field as it was pasted, line breaks aside — a secret's
      // trailing newline is no part of it — and, like any paste, not sent.
      if (filling()) {
        set(buffer.current + text.replace(/[\r\n]/g, ""));
        return;
      }
      if (reasonFor.current !== undefined) {
        set(buffer.current + oneLine(text));
        return;
      }
      // A pasted command waits for Enter, as a pasted prompt does.
      const pasted = oneLine(text).trimEnd();
      if (takesCommand(pasted)) typeCommand(pasted, false);
      else if (accepting()) set(buffer.current + oneLine(text));
    },
    { isActive: onSubmit !== undefined || onForm !== undefined },
  );
  useInput((character, key) => {
    if (exiting) return;
    if (key.ctrl && character === "c") {
      setExiting(true);
      return;
    }
    // A form takes every key until it is sent or cancelled: none is a y, an n
    // or an abort, and what is typed is its field's.
    if (filling() && onForm !== undefined) {
      if (key.escape) {
        set("");
        onForm.cancel();
        return;
      }
      if (erased(key) || key.ctrl || key.meta) return;
      if (key.return && !/[\r\n]/.test(character)) {
        const typedValue = buffer.current;
        set("");
        onForm.enter(typedValue);
        return;
      }
      // Typed fast, one chunk may answer several fields: each line one, for as
      // long as the form is open. What follows its end is dropped — never
      // left in the prompt, where it would be shown, or sent as a prompt.
      const lines = character.split(/\r\n?|\n/);
      for (const [index, line] of lines.entries()) {
        if (!filling()) break;
        if (index === lines.length - 1) {
          set(buffer.current + line);
          break;
        }
        const typedValue = buffer.current + line;
        set("");
        onForm.enter(typedValue);
      }
      return;
    }
    // Before Esc aborts anything: here Esc only cancels the rejection. A round
    // decided elsewhere, or a task that moved on, ends the reason at once, and
    // the key is read as it would have been.
    if (reasonFor.current !== undefined && store.decisionNow()?.steps !== reasonFor.current.steps) {
      reasonFor.current = undefined;
      set("");
      store.note(store.t("tui.reason.stale"), "notice");
    }
    const rejecting = reasonFor.current;
    if (rejecting !== undefined && onDecide !== undefined) {
      if (key.escape) {
        reasonFor.current = undefined;
        set("");
        store.note(store.t("tui.reason.cancelled"), "notice");
        return;
      }
      if (erased(key) || key.ctrl || key.meta) return;
      if (key.return || /[\r\n]/.test(character)) {
        const note = (buffer.current + oneLine(character)).trim().slice(0, 500);
        reasonFor.current = undefined;
        set("");
        // The round moved on meanwhile: the owner refuses it, as for any key.
        onDecide({ taskId: rejecting.taskId, steps: rejecting.steps, approved: false, ...(note === "" ? {} : { note }) });
        return;
      }
      if (character !== "") set(buffer.current + character);
      return;
    }
    // Esc drops a command half typed, wherever: it aborts nothing.
    if (key.escape && commandGoing()) {
      set("");
      return;
    }
    // A chunk typed fast may carry the whole command and its Enter.
    const typed = oneLine(character).trimEnd();
    const entered = key.return || /[\r\n]/.test(character);
    if (takesCommand(typed)) {
      if (erased(key) || key.ctrl || key.meta || key.escape) return;
      typeCommand(typed, entered);
      return;
    }
    // The store's state now, not the last frame's view: keys in one chunk see
    // the ones before them, so "yn" sends one decision and a double Esc one abort.
    if (key.escape && onAbort !== undefined) {
      const abortable = store.abortableNow();
      if (abortable !== undefined) onAbort(abortable.taskId);
      return;
    }
    if (onDecide !== undefined && store.decisionNow() !== undefined) {
      answerRound(
        character,
        () => store.decisionNow(),
        (decision, verdict) => onDecide({ taskId: decision.taskId, steps: decision.steps, ...verdict }),
        (decision, rest) => {
          reasonFor.current = decision;
          set("");
          store.note(store.t("tui.reason.ask", { steps: String(decision.steps) }), "notice");
          const [first, ...after] = rest.split(/\r\n?|\n/);
          if (after.length === 0) {
            set(first ?? "");
            return;
          }
          // The chunk carried the reason's Enter too.
          const note = (first ?? "").trim().slice(0, 500);
          reasonFor.current = undefined;
          set("");
          onDecide({ taskId: decision.taskId, steps: decision.steps, approved: false, ...(note === "" ? {} : { note }) });
        },
      );
      return;
    }
    if (onReview !== undefined && store.reviewNow() !== undefined) {
      answerWith(
        character,
        () => store.reviewNow(),
        (review, approved) => onReview({ ...review, approved }),
      );
      return;
    }
    if (!accepting()) return;
    if (erased(key) || key.ctrl || key.meta) return;
    if (entered) {
      set(buffer.current + typed);
      submit();
      return;
    }
    if (character !== "") set(buffer.current + character);
  });

  return (
    <>
      <Static items={view.committed as ChatLine[]}>
        {(line: ChatLine) => {
          const text = (
            <Text key={line.id} {...TONES[line.tone]}>
              {/* An empty Text takes no row: a blank line would vanish from the scrollback. */}
              {line.text === "" ? " " : line.text}
            </Text>
          );
          // A word wider than the terminal (a path) is never broken by a newline: the terminal soft-wraps the line.
          const wide = unbrokenWidth(line.text, columns);
          return wide === undefined ? (
            text
          ) : (
            <Box key={line.id} width={wide}>
              {text}
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column">
        {view.live.map((row, index) => (
          // Truncated, never wrapped: the store counted one row per entry.
          <Text key={index} wrap="truncate-end">
            {row}
          </Text>
        ))}
        <Text wrap="truncate-end" {...UI_TONES.status}>
          {view.status === "" ? " " : view.status}
        </Text>
        {/* The tail of what is being typed stays in sight; still one row. */}
        <Text wrap="truncate-start">
          {/* A credential's shape is masked wherever it is typed: it is refused on Enter, and never drawn before. */}
          {view.form !== undefined
            ? `${view.form.label} ${GLYPHS.prompt} ${view.form.secret || looksLikeCredential(input) ? masked(input) : input}${exiting ? "" : BLINK_CURSOR}`
            : reasonFor.current !== undefined && view.decision?.steps === reasonFor.current.steps
              ? `${store.t("tui.reason.prompt")} ${GLYPHS.prompt} ${looksLikeCredential(input) ? masked(input) : input}${exiting ? "" : BLINK_CURSOR}`
              : onSubmit === undefined
                ? " "
                : `${GLYPHS.prompt} ${view.running && view.answer === undefined && (view.decision !== undefined || view.review !== undefined) && !mayBecomeCommand(input, pluginCommands()) ? "" : looksLikeCredential(input) ? masked(input) : input}${exiting ? "" : BLINK_CURSOR}`}
        </Text>
      </Box>
    </>
  );
}
