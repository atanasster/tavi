import {
  BROWSER_LIVE_ENDED_TASK,
  type BrowserLiveFrameMetadata,
  type BrowserLiveMessage,
  type BrowserLivePhoneViewport,
} from "@tavi/contracts";
import type { LiveWatch } from "@tavi/client/browser";
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

import { translateNow } from "../../lib/i18n.js";
import { refusal } from "../../lib/ipc.js";
import { InputBatcher } from "./input.js";
import type { TakeoverClient } from "./Takeover.js";

/** A connection back within this long resumes the person's control by itself; after it, they are asked. */
const TAKEOVER_RESUME_GRACE_MS = 10_000;

/** Where the takeover stands: taking it, in control here, elsewhere or unattended, handed back, or failed. */
export type Phase = "taking" | "pending" | "control" | "elsewhere" | "unattended" | "released" | "failed";

/** The page's latest frame. */
export interface Picture {
  readonly src: string;
  readonly metadata: BrowserLiveFrameMetadata;
}

type Setter<T> = Dispatch<SetStateAction<T>>;

/**
 * The takeover surface's watch of the one session, and its take: opened once
 * per session (reopening would close the batcher and drop what was typed),
 * each message the owner sends landing in Takeover's state. Leaving keeps
 * control: the owner holds it, unattended, until taken again or handed back.
 */
export function useTakeoverWatch({
  client,
  taskId,
  workspaceId,
  sessionId,
  now,
  batcher,
  lastInput,
  watch,
  control,
  streamWidth,
  takeOptions,
  announce,
  phaseRef,
  handingBack,
  surface,
  setPhase,
  setPicture,
  setRequested,
  setSessionDeadline,
  setLocation,
  setPicker,
  setDialog,
  setDialogText,
  setChooser,
  setFailure,
}: {
  readonly client: TakeoverClient;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly now: () => number;
  readonly batcher: RefObject<InputBatcher | undefined>;
  readonly lastInput: RefObject<number>;
  readonly watch: RefObject<LiveWatch | undefined>;
  readonly control: (request: Parameters<LiveWatch["control"]>[0]) => Promise<boolean>;
  readonly streamWidth: () => number;
  /** What a take asks for: the stream's width, and a phone's size for the page. */
  readonly takeOptions: () => { readonly maxWidth: number; readonly viewport?: BrowserLivePhoneViewport };
  readonly announce: (text: string) => void;
  readonly phaseRef: RefObject<Phase>;
  readonly handingBack: RefObject<boolean>;
  readonly surface: RefObject<HTMLDivElement | null>;
  readonly setPhase: Setter<Phase>;
  readonly setPicture: Setter<Picture | undefined>;
  readonly setRequested: Setter<boolean>;
  readonly setSessionDeadline: Setter<string | undefined>;
  readonly setLocation: Setter<{ url?: string; title?: string }>;
  readonly setPicker: Setter<Extract<BrowserLiveMessage, { kind: "select" }> | undefined>;
  readonly setDialog: Setter<Extract<BrowserLiveMessage, { kind: "dialog" }> | undefined>;
  readonly setDialogText: Setter<string>;
  readonly setChooser: Setter<Extract<BrowserLiveMessage, { kind: "chooser" }> | undefined>;
  readonly setFailure: Setter<string | undefined>;
}): void {
  // The latest client, read when the watch opens: its identity never reopens it.
  const clientRef = useRef(client);
  clientRef.current = client;

  // The watch, and the take: once per session. Reopening would close the batcher and drop what was typed.
  useEffect(() => {
    let alive = true;
    const width = streamWidth();
    batcher.current = new InputBatcher(async (events, seq) => {
      lastInput.current = now();
      await control({ action: "input", sessionId, seq, events: [...events] });
    });
    void clientRef.current
      .liveWatch(taskId, {
        workspaceId,
        sessionId,
        maxWidth: width,
        onMessage: (message, ack) => {
          if (!alive) return ack();
          if (message.kind === "frame") {
            setPicture({ src: `data:${message.mime};base64,${message.data}`, metadata: message.metadata });
            // Shown at the next paint; the credit goes back then.
            requestAnimationFrame(() => ack());
            return;
          }
          ack();
          // The agent asked for a person: however the surface was opened, its wait bounds the time, not the idle check.
          // (Or it is already taken, its request's deadline still standing.)
          if (message.kind === "session" && (message.control === "requested" || message.handoffDeadlineAt !== undefined))
            setRequested(true);
          // The request's deadline, from the session itself: a surface opened from a card that knew none still shows the time left.
          if (message.kind === "session" && message.handoffDeadlineAt !== undefined) setSessionDeadline(message.handoffDeadlineAt);
          if (message.kind === "session")
            setLocation({
              ...(message.url === undefined ? {} : { url: message.url }),
              ...(message.title === undefined ? {} : { title: message.title }),
            });
          else if (message.kind === "navigated")
            setLocation({ url: message.url, ...(message.title === undefined ? {} : { title: message.title }) });
          else if (message.kind === "select") setPicker(message);
          else if (message.kind === "dialog") {
            setDialog(message);
            setDialogText(message.defaultValue ?? "");
          } else if (message.kind === "chooser") {
            setChooser(message);
            announce(translateNow("takeover.watch.chooser"));
          } else if (message.kind === "notice") announce(translateNow("takeover.watch.shortcut"));
          // A session whose task ended is kept: still the person's to take, so only a closed one is over.
          else if (message.kind === "ended" && message.reason !== BROWSER_LIVE_ENDED_TASK) {
            setPhase("released");
            announce(translateNow("takeover.watch.ended"));
          } else if (message.kind === "control") {
            if (message.pending === true) setPhase("pending");
            else if (message.state === "operator") {
              // This surface held it, and its connection came back within the grace: it takes it again by itself.
              if (
                message.controller === "none" &&
                phaseRef.current === "control" &&
                (message.unattendedMs ?? Number.POSITIVE_INFINITY) <= TAKEOVER_RESUME_GRACE_MS
              ) {
                // Refused (another tab was quicker): it is asked, as after the grace.
                void watch.current?.control({ action: "take", sessionId, ...takeOptions() }).then((answer) => {
                  if (!answer.ok && alive) setPhase("unattended");
                });
                return;
              }
              // No tab holds it (this one reconnected after the grace, or the one that had it left): it is still the person's.
              setPhase(message.controller === "you" ? "control" : message.controller === "none" ? "unattended" : "elsewhere");
              announce(
                message.controller === "you"
                  ? translateNow("takeover.watch.control")
                  : message.controller === "none"
                    ? translateNow("takeover.watch.unattended")
                    : translateNow("takeover.watch.elsewhere"),
              );
            } else if (message.state === "agent") {
              // Taken back without this surface handing it back: the deadline, the idle limit, or a cancel.
              setPhase((previous) => {
                const held = previous === "control" || previous === "elsewhere" || previous === "unattended";
                // Only a page that was the person's goes back; a take that failed or was superseded never had it.
                if (held && !handingBack.current) announce(translateNow("takeover.page.back"));
                return held ? "released" : previous;
              });
            }
          }
        },
        onEnd: () => {
          if (alive) setPhase((previous) => (previous === "released" ? previous : "failed"));
        },
      })
      .then(async (opened) => {
        if (!alive) {
          await opened.watch?.close();
          return;
        }
        if (opened.watch === undefined) {
          setPhase("failed");
          setFailure(refusal(opened.response, translateNow("takeover.watch.unshown")));
          return;
        }
        watch.current = opened.watch;
        const taken = await opened.watch.control({ action: "take", sessionId, ...takeOptions(), maxWidth: width });
        if (!alive) return;
        if (!taken.ok) {
          setPhase("failed");
          setFailure(refusal(taken, translateNow("takeover.watch.untaken")));
        } else {
          setPhase("control");
          surface.current?.focus();
        }
      });
    return () => {
      alive = false;
      batcher.current?.close();
      // Leaving keeps control: the owner holds it, unattended, until taken again or handed back.
      void watch.current?.close();
      watch.current = undefined;
    };
  }, [workspaceId, taskId, sessionId]);
}
