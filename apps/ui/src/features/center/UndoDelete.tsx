import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { errorMessage } from "@tavi/contracts/util";

import type { ActionTone } from "../../hooks/use-action.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { Outcome } from "../../lib/ipc.js";
import { Button } from "../../ui/Button.js";
import { focusRowMenu } from "./RecurringRow.js";

/** How long a delete waits for its Undo before the owner is asked. */
export const UNDO_DELETE_MS = 8_000;

/**
 * The longest a wait may stand still in all, however long Undo keeps focus or
 * the pointer: a delete is made in the end even when nobody moves away.
 */
export const UNDO_PAUSE_MAX_MS = 30_000;

/** The heading focus goes to when the toast closes while it has focus. */
export const UNDO_DELETE_RETURN_ID = "center-recurring-title";

/** A delete on hold: the workspace it is in, the row it hides (`key`), what it is called, and the owner call it makes once nobody undid it. */
interface Held {
  readonly scope: string;
  readonly key: string;
  readonly name: string;
  readonly commit: () => Promise<Outcome<unknown>>;
}

/** What the lists draw from: the same for every list, so it outlives any one of them. */
interface Snapshot {
  readonly held: { readonly key: string; readonly name: string } | undefined;
  readonly hidden: ReadonlySet<string>;
  /** What the last delete said once the owner answered, and in which workspace. */
  readonly said: { readonly scope: string; readonly note: string; readonly tone: ActionTone } | undefined;
  readonly paused: boolean;
}

export interface UndoDelete {
  /** The rows a delete hides: on hold, or done. */
  readonly hidden: ReadonlySet<string>;
  /** The delete waiting for its Undo, if any. */
  readonly held: { readonly key: string; readonly name: string } | undefined;
  /** Hide `key` now and delete it once the wait is over; a delete already waiting is made at once. */
  readonly hold: (key: string, name: string, commit: () => Promise<Outcome<unknown>>) => void;
  /** The waiting delete is not made: its row comes back as it was. */
  readonly undo: () => void;
  /**
   * The wait stops while the person puts focus or the pointer on the toast, and goes on from where it was once it
   * has neither, or once it has stood still for `UNDO_PAUSE_MAX_MS` in all.
   */
  readonly pause: () => void;
  readonly resume: () => void;
  readonly paused: boolean;
  /** What the last delete said once the owner answered: done, or its refusal. */
  readonly note: string | undefined;
  readonly tone: ActionTone;
}

/**
 * The one delete waiting, kept outside any list, so leaving Schedule for
 * another section, a chat or a page of its own neither makes it at once nor
 * loses the owner's answer: the wait goes on, Undo is there again on return
 * while it lasts, and a refusal is said there.
 */
let state: Snapshot = { held: undefined, hidden: new Set(), said: undefined, paused: false };
let waiting: Held | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let remaining = 0;
/** How long the waiting delete may still stand still, and the timer that ends a pause once it has used that up. */
let pauseLeft = 0;
let pausedAt = 0;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
/** A refusal that came while no list was shown: said when one is. */
let unseen = false;
/** The delete just asked, whose Undo takes focus once shown; one shown again on return to Schedule does not. */
let fresh: string | undefined;
const listeners = new Set<() => void>();
/** The lists shown now, each read again once the owner answers. */
const lists = new Set<{ readonly current: () => void }>();

const update = (next: Partial<Snapshot>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const show = (key: string, shown: boolean): void => {
  const hidden = new Set(state.hidden);
  if (shown) hidden.delete(key);
  else hidden.add(key);
  update({ hidden });
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = (): Snapshot => state;

function start(delayMs: number): void {
  remaining = delayMs;
  deadline = Date.now() + delayMs;
  timer = setTimeout(flush, delayMs);
}

function flush(): void {
  const pending = waiting;
  if (pending === undefined) return;
  waiting = undefined;
  clearTimeout(timer);
  clearTimeout(pauseTimer);
  update({ held: undefined, paused: false });
  void pending
    .commit()
    .catch((failure: unknown): Outcome<unknown> => ({ ok: false, message: errorMessage(failure) }))
    .then((done) => {
      if (!done.ok) {
        show(pending.key, true);
        unseen = lists.size === 0;
        update({
          said: {
            scope: pending.scope,
            note: translateNow("center.undoDelete.notDeleted", { name: pending.name, reason: done.message }),
            tone: "failure",
          },
        });
      } else if (lists.size > 0)
        update({ said: { scope: pending.scope, note: translateNow("center.undoDelete.deleted", { name: pending.name }), tone: "note" } });
      // Nobody is looking: the lists read on return no longer have it.
      else show(pending.key, true);
      for (const list of lists) list.current();
    });
}

function hold(scope: string, key: string, name: string, commit: () => Promise<Outcome<unknown>>, delayMs: number): void {
  flush();
  // Leaving the page makes the waiting delete, whatever is shown then.
  if (!listening) window.addEventListener("pagehide", flush);
  listening = true;
  waiting = { scope, key, name, commit };
  fresh = key;
  pauseLeft = UNDO_PAUSE_MAX_MS;
  show(key, false);
  update({ said: undefined, held: { key, name }, paused: false });
  start(delayMs);
}

function undo(): void {
  const pending = waiting;
  if (pending === undefined) return;
  waiting = undefined;
  clearTimeout(timer);
  clearTimeout(pauseTimer);
  show(pending.key, true);
  update({
    held: undefined,
    paused: false,
    said: { scope: pending.scope, note: translateNow("center.undoDelete.kept", { name: pending.name }), tone: "note" },
  });
  // The row is back: focus goes to its More button, where the delete was asked.
  focusRowMenu(pending.key);
}

function pause(): void {
  if (waiting === undefined || state.paused || pauseLeft <= 0) return;
  clearTimeout(timer);
  remaining = Math.max(deadline - Date.now(), 0);
  pausedAt = Date.now();
  pauseTimer = setTimeout(resume, pauseLeft);
  update({ paused: true });
}

function resume(): void {
  if (waiting === undefined || !state.paused) return;
  clearTimeout(pauseTimer);
  pauseLeft = Math.max(pauseLeft - (Date.now() - pausedAt), 0);
  start(remaining);
  update({ paused: false });
}

/**
 * Delete with Undo instead of a confirm. The row is hidden at once and the
 * owner is asked only once `delayMs` passes without an Undo, so undoing
 * keeps the thing itself (its id and history), not a copy of it. A delete
 * still waiting is made at once when another starts, when the page is left
 * (`pagehide`) and when Schedule opens for another workspace (`scope`). A
 * refused delete brings its row back and says why; `settled` then reads the
 * lists again.
 */
export function useUndoDelete(settled: () => void, scope: string, delayMs: number = UNDO_DELETE_MS): UndoDelete {
  const current = useSyncExternalStore(subscribe, snapshot);
  const latestSettled = useRef(settled);
  latestSettled.current = settled;

  useEffect(() => {
    if (waiting !== undefined && waiting.scope !== scope) flush();
    if (state.said?.scope === scope) unseen = false;
    const list = { current: () => latestSettled.current() };
    lists.add(list);
    return () => {
      lists.delete(list);
      if (lists.size > 0) return;
      // The lists read on return no longer have what was deleted: only the delete waiting stays hidden.
      update({ hidden: new Set(waiting === undefined ? [] : [waiting.key]) });
      // What the owner said is said where the delete was asked, until Schedule is left; a refusal nobody saw waits for its return.
      if (!unseen) update({ said: undefined });
    };
  }, [scope]);

  const said = current.said?.scope === scope ? current.said : undefined;
  return {
    hidden: current.hidden,
    held: current.held,
    hold: (key, name, commit) => hold(scope, key, name, commit, delayMs),
    undo,
    pause,
    resume,
    paused: current.paused,
    note: said?.note,
    tone: said?.tone ?? "note",
  };
}

/**
 * The delete waiting for its Undo, said at the foot of the page: its name,
 * Undo (which takes focus, since the row it was asked from is gone) and a bar
 * that runs out with the wait. The focus it is given does not stop the wait,
 * so a delete nobody undoes is made; the wait stops, for a bounded time, only
 * while the person moves focus back to the toast or puts the pointer on it.
 * Should the toast close while it has focus, focus goes to the Recurring
 * heading rather than the page. The status region stays mounted so each
 * delete is announced.
 */
export function UndoToast({ undo, delayMs = UNDO_DELETE_MS }: { readonly undo: UndoDelete; readonly delayMs?: number }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  const given = useRef(false);
  const key = undo.held?.key;
  useEffect(() => {
    if (key !== undefined && key === fresh) {
      fresh = undefined;
      given.current = true;
      button.current?.focus();
      given.current = false;
    } else if (key === undefined && hadFocus.current && (document.activeElement === null || document.activeElement === document.body))
      document.getElementById(UNDO_DELETE_RETURN_ID)?.focus();
    hadFocus.current = false;
  }, [key]);
  return (
    <div className="undo-toast-region" role="status">
      {undo.held === undefined ? null : (
        <ToastBody key={undo.held.key} undo={undo} hadFocus={hadFocus} given={given}>
          <span className="undo-toast-text">{t("center.undoDelete.deleted", { name: undo.held.name })}</span>
          <Button
            ref={button}
            size="sm"
            variant="ghost"
            aria-label={t("center.undoDelete.undoLabel", { name: undo.held.name })}
            onClick={undo.undo}
          >
            {t("center.undoDelete.undo")}
          </Button>
          <span className="need-undo-bar" aria-hidden="true" style={{ animationDuration: `${delayMs}ms` }} />
        </ToastBody>
      )}
    </div>
  );
}

/**
 * The toast itself: it holds the wait while the person gives it focus or the pointer (not the focus it was given as
 * it opened), and records, as it closes, whether it had focus.
 */
function ToastBody({
  undo,
  hadFocus,
  given,
  children,
}: {
  readonly undo: UndoDelete;
  readonly hadFocus: { current: boolean };
  /** Set while the toast moves focus to Undo itself. */
  readonly given: { readonly current: boolean };
  readonly children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const hovered = useRef(false);
  // Runs before the toast leaves the page, while focus is still in it; a wait it held goes on.
  useLayoutEffect(
    () => () => {
      hadFocus.current = body.current?.contains(document.activeElement) === true;
      undo.resume();
    },
    [hadFocus, undo.resume],
  );
  return (
    <div
      ref={body}
      className={undo.paused ? "undo-toast undo-toast-paused" : "undo-toast"}
      onFocus={(event) => {
        if (given.current || event.currentTarget.contains(event.relatedTarget)) return;
        focused.current = true;
        undo.pause();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget) || !focused.current) return;
        focused.current = false;
        if (!hovered.current) undo.resume();
      }}
      onPointerEnter={() => {
        hovered.current = true;
        undo.pause();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        if (!focused.current) undo.resume();
      }}
    >
      {children}
    </div>
  );
}
