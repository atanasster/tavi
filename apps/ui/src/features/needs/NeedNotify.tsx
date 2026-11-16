import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NeedRow } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { answerNeed, listNeeds } from "../center/approvals-api.js";
import { useAnnounce } from "../../hooks/use-announce.js";
import { readStored, writeStored } from "../../lib/storage.js";
import { Icon } from "../../ui/Icon.js";
import { QuestionCard, answerOutcome, questionNeed, type AnswerState } from "./NeedCard.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";

/**
 * Wherever you are: a need that arrives while
 * the page is open says so — a toast on the page (a question answerable right
 * in it) when it is not the chat in view, a browser notification when the tab
 * is hidden and notifications are on, and a dot in the tab's icon while
 * anything waits. Notifications are off until turned on, and asked for in
 * context: the first time a need arrives while the tab was hidden.
 */

/** Whether the reader turned need notifications on (`on`) or declined being asked (`off`); unset, not yet asked. */
export const NEED_NOTIFY_STORAGE_KEY = "tavi.needs.notify";

type NotifyPreference = "on" | "off" | undefined;

function readPreference(): NotifyPreference {
  const stored = readStored(NEED_NOTIFY_STORAGE_KEY);
  return stored === "on" || stored === "off" ? stored : undefined;
}

/** Storage blocked: the choice holds for this page only. */
function writePreference(value: "on" | "off"): void {
  writeStored(NEED_NOTIFY_STORAGE_KEY, value);
}

const permission = (): NotificationPermission | "unsupported" =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

/**
 * A desktop notification, when the reader turned them on and the page is not
 * in view: for something that needs them now and is not one of the owner's
 * listed needs (a browser handoff). Says nothing otherwise.
 */
export function notifyHidden(title: string, body: string, tag: string): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  if (permission() !== "granted" || readPreference() !== "on") return;
  try {
    const shown = new Notification(title, { body, tag });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
  } catch {
    // A browser that wants a service worker for page notifications: the tab's title still says it.
  }
}

/** What a need says in one line: the question, or the call an approval names. */
export function needHeadline(need: NeedRow): { readonly title: string; readonly body: string } {
  if (need.kind === "question")
    return { title: `${need.question.originLabel ?? need.question.taskTitle ?? "A chat"} asks`, body: need.question.question };
  if (need.kind === "approval")
    return { title: `${need.approval.taskTitle ?? "A chat"} needs approval`, body: need.approval.summary ?? need.approval.toolId };
  if (need.kind === "connect")
    return {
      title: `${need.connect.taskTitle ?? "A chat"} waits for ${need.connect.appName}`,
      body: `Sign in to ${need.connect.appName} again`,
    };
  return { title: `${need.review.taskTitle ?? "A chat"} has results to review`, body: plural(need.review.artifactCount, "result") };
}

export interface NeedToastState {
  readonly need: NeedRow;
  /** How many others arrived with it. */
  readonly more: number;
}

/**
 * Watches the needs queue as the feed reports changes, and says what is new.
 * The first read is the baseline: opening the page never replays what was
 * already waiting.
 */
export function useNeedNotifications({
  client,
  workspaceId,
  enabled,
  revision,
  currentTaskId,
  onOpen,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  /** Only against an owner with the Command Center, which lists needs. */
  readonly enabled: boolean;
  /** Moves when the feed reports an approval, a question or a review. */
  readonly revision: number;
  /** The chat in view: its own needs show there, not in a toast. */
  readonly currentTaskId: string | undefined;
  /** Go to a need: its task, or the inbox. */
  readonly onOpen: (need: NeedRow) => void;
}): {
  readonly toast: NeedToastState | undefined;
  readonly dismiss: () => void;
  /** Ask whether to turn notifications on: a need arrived while the tab was hidden, and the reader has not chosen yet. */
  readonly offer: boolean;
  readonly accept: () => void;
  readonly decline: () => void;
  /** The toast's question was answered in it: it stays, as its receipt, when the queue drops it. */
  readonly answeredHere: () => void;
  readonly count: number;
} {
  const seen = useRef<Set<string> | undefined>(undefined);
  const [toast, setToast] = useState<NeedToastState>();
  const [offer, setOffer] = useState(false);
  const [count, setCount] = useState(0);
  const latest = useRef({ currentTaskId, onOpen });
  latest.current = { currentTaskId, onOpen };
  /** Whether the open toast was answered in it. */
  const toastAnswered = useRef(false);
  // Opening the toast's task shows its need there: the toast has said its piece.
  useResetOnChange([currentTaskId, toast?.need.taskId], () => {
    if (currentTaskId !== undefined && toast?.need.taskId === currentTaskId) setToast(undefined);
  });

  useEffect(() => {
    seen.current = undefined;
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void listNeeds(client, workspaceId).then((answer) => {
      if (!current || !answer.ok) return;
      const needs = answer.value.needs;
      setCount(needs.length);
      // A toast whose need was resolved elsewhere goes, unless it was answered in it.
      setToast((held) =>
        held === undefined || toastAnswered.current || needs.some((need) => need.needId === held.need.needId) ? held : undefined,
      );
      if (seen.current === undefined) {
        seen.current = new Set(needs.map((need) => need.needId));
        return;
      }
      const fresh = needs.filter((need) => !seen.current?.has(need.needId));
      for (const need of needs) seen.current.add(need.needId);
      if (fresh.length === 0) return;
      // The newest first: what just asked is what the reader should see.
      const ordered = [...fresh].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt));
      const elsewhere = ordered.filter((need) => need.taskId !== latest.current.currentTaskId);
      const [first, ...rest] = elsewhere;
      // One toast at a time: an open one is never replaced under the reader
      // (an answer may be in its undo window); what else arrives is "+n more".
      if (first !== undefined) {
        setToast((held) => {
          if (held !== undefined) return { ...held, more: held.more + elsewhere.length };
          toastAnswered.current = false;
          return { need: first, more: rest.length };
        });
      }
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!hidden) return;
      const preference = readPreference();
      if (preference === undefined && permission() !== "denied" && permission() !== "unsupported") setOffer(true);
      if (permission() !== "granted" || preference !== "on") return;
      // One notification for the newest, however many arrived: a burst is one interruption.
      const [newest] = ordered;
      if (newest === undefined) return;
      const { title, body } = needHeadline(newest);
      try {
        // A notification has no actions: a click opens the page, where a decision is made.
        const shown = new Notification(title, {
          body: ordered.length > 1 ? `${body} (+${ordered.length - 1} more)` : body,
          tag: newest.needId,
        });
        shown.onclick = () => {
          window.focus();
          latest.current.onOpen(newest);
          shown.close();
        };
      } catch {
        // A browser that wants a service worker for page notifications: the toast and the tab's title still say it.
      }
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, enabled, revision]);

  return {
    toast,
    dismiss: () => setToast(undefined),
    offer,
    accept: () => {
      setOffer(false);
      if (permission() !== "default") {
        writePreference("on");
        return;
      }
      void Promise.resolve(Notification.requestPermission())
        .then((answer) => writePreference(answer === "granted" ? "on" : "off"))
        // Best effort: a permission prompt that fails leaves the preference as it was.
        .catch(() => undefined);
    },
    decline: () => {
      setOffer(false);
      writePreference("off");
    },
    answeredHere: () => {
      toastAnswered.current = true;
    },
    count,
  };
}

/**
 * A dot in the tab's icon while anything waits: seen in a row of tabs where the
 * title is cut. Drawn in the warning token, read from the page's own theme.
 */
export function useFaviconDot(waiting: number): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const id = "tavi-needs-icon";
    const held = document.getElementById(id);
    if (waiting === 0) {
      held?.remove();
      return;
    }
    const token = getComputedStyle(document.documentElement).getPropertyValue("--warning").trim();
    const fill = token === "" ? "currentColor" : `hsl(${token})`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="${fill}"/></svg>`;
    const link = held instanceof HTMLLinkElement ? held : Object.assign(document.createElement("link"), { id, rel: "icon" });
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    if (held === null) document.head.append(link);
    // Gone with the page that drew it.
    return () => link.remove();
  }, [waiting > 0]);
}

/**
 * The toast for a need from another chat: a question answered in it, anything
 * else with the way to it. At most one; what else arrived is "+n more".
 */
/** The id a "Jump to notification" link targets: the toast, or the offer, whichever is up. */
export const NEED_TOAST_ID = "need-toast";

/**
 * A toast that goes away with focus inside it (Dismiss, Not now) leaves focus
 * at the page's main content, not lost on the page's body.
 */
function useFocusMainOnLeave(box: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = box.current;
    return () => {
      if (element?.contains(document.activeElement) === true) document.getElementById("main")?.focus({ preventScroll: true });
    };
  }, [box]);
}

export function NeedToast({
  toast,
  onOpen,
  onOpenAll,
  onDismiss,
  onAnswered,
}: {
  readonly toast: NeedToastState;
  readonly onOpen: (need: NeedRow) => void;
  readonly onOpenAll: () => void;
  readonly onDismiss: () => void;
  /** Told when the question was answered in the toast. */
  readonly onAnswered?: (() => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [answer, setAnswer] = useState<AnswerState>();
  const box = useRef<HTMLElement>(null);
  useFocusMainOnLeave(box);
  const { need, more } = toast;
  const { title, body } = needHeadline(need);
  return (
    // Not a live region: the page's announcer already says what waits, and the
    // card's own status lines would be read twice inside one.
    <aside ref={box} id={NEED_TOAST_ID} tabIndex={-1} className="need-toast" aria-label="Needs you">
      <div className="need-toast-head">
        <strong>{title}</strong>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="close" size="sm" />
        </Button>
      </div>
      {need.kind === "question" ? (
        <QuestionCard
          density="compact"
          timeZone={timeZone}
          need={questionNeed(need.question)}
          answer={answer}
          onAnswer={(text) => {
            setAnswer({ status: "sending", text });
            void answerNeed(client, { workspaceId, taskId: need.taskId, waitId: need.question.waitId, answer: text }).then((outcome) => {
              if (outcome.ok) onAnswered?.();
              setAnswer(answerOutcome(text, outcome));
            });
          }}
        />
      ) : (
        <p className="need-toast-body">{body}</p>
      )}
      <div className="need-toast-actions">
        <Button size="sm" onClick={() => onOpen(need)}>
          Open the task
        </Button>
        {more === 0 ? null : (
          <Button variant="ghost" size="sm" onClick={onOpenAll}>
            +{more} more in Approvals
          </Button>
        )}
      </div>
    </aside>
  );
}

const NOTIFY_OFFER_TEXT = "Something needed you while this tab was in the background. Get a browser notification next time?";

/** The one-time, in-context question: notify me when something needs me? */
export function NotifyOffer({ onAccept, onDecline }: { readonly onAccept: () => void; readonly onDecline: () => void }) {
  const box = useRef<HTMLElement>(null);
  useFocusMainOnLeave(box);
  // It comes up unasked, at the page's end: said, so a screen reader hears it is there.
  useAnnounce(`Notifications are available: ${NOTIFY_OFFER_TEXT}`);
  return (
    <aside ref={box} id={NEED_TOAST_ID} tabIndex={-1} className="need-toast need-offer" aria-label="Notifications">
      <p>
        <Icon name="bell" size="sm" /> {NOTIFY_OFFER_TEXT}
      </p>
      <div className="need-toast-actions">
        <Button variant="primary" size="sm" onClick={onAccept}>
          Turn on
        </Button>
        <Button variant="ghost" size="sm" onClick={onDecline}>
          Not now
        </Button>
      </div>
    </aside>
  );
}

/**
 * The reader's own switch for need notifications, where they can always find
 * it (the Approvals header): on asks the browser for permission when it has
 * not been given; off stays off until turned on here.
 */
export function NeedNotifyToggle() {
  const [preference, setPreference] = useState<NotifyPreference>(readPreference);
  const [state, setState] = useState(permission);
  if (state === "unsupported") return null;
  if (state === "denied") return <span className="muted">Notifications are blocked for this site in the browser's settings</span>;
  const on = preference === "on" && state === "granted";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={on}
      onClick={() => {
        if (on) {
          writePreference("off");
          setPreference("off");
          return;
        }
        const finish = (answer: NotificationPermission) => {
          setState(answer);
          const next = answer === "granted" ? "on" : "off";
          writePreference(next);
          setPreference(next);
        };
        if (state === "granted") finish("granted");
        else
          void Promise.resolve(Notification.requestPermission())
            .then(finish)
            .catch(() => setState(permission()));
      }}
    >
      <Icon name="bell" size="sm" /> {on ? "Notifications on" : "Notify me"}
    </Button>
  );
}
