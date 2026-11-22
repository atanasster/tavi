import {
  BROWSER_LIVE_CONTROL_MAX_WIDTH,
  BROWSER_LIVE_NOTE_MAX,
  BROWSER_LIVE_PHONE_MAX_HEIGHT,
  BROWSER_LIVE_PHONE_MAX_WIDTH,
  BROWSER_LIVE_PHONE_MIN_SIZE,
  type BrowserLiveMessage,
  type BrowserLivePhoneViewport,
} from "@tavi/contracts";
import type { LiveWatch, TaviClient } from "@tavi/client/browser";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "../../lib/i18n.js";
import { refusal } from "../../lib/ipc.js";
import { useModalFocus } from "../../hooks/use-modal-focus.js";
import { useNow } from "../../hooks/use-poll.js";
import { isPhone, usePhone } from "../../hooks/page.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { NoteForm } from "./NoteForm.js";
import { type InputBatcher, textEvents, uploadChunks, uploadRefusal } from "./input.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { surfaceInput, type TouchState } from "./surface-input.js";
import { useTakeoverWatch, type Phase, type Picture } from "./use-takeover-watch.js";
import { TAKEOVER_DEADLINE_WARNING_MS, TakeoverBar } from "./TakeoverBar.js";
import { TakeoverChooser, TakeoverDialog, TakeoverPicker } from "./TakeoverPopovers.js";

/**
 * The takeover surface: the page
 * large, under the person's hands, with the host's own bar. Drawn by the
 * canvas itself, never by a plugin: what is typed here goes from this page to
 * the owner and the page, and nowhere else.
 *
 * - **Taking.** It opens a watch of the one session and asks to take it; the
 *   owner answers once the agent's step in flight settles ("Taking control
 *   after the current step…").
 * - **In control.** Pointer, wheel, keys (Escape included: release is always a
 *   button), paste and — on a phone — a hidden text field's input go to the
 *   page in batches. `<select>` lists and dialogs the page opens are drawn
 *   here. The bar hands back (with an optional note), says it could not be
 *   done, or stops the task.
 * - **Reminders.** A handoff the agent asked for shows its time left, and a
 *   banner in its last two minutes. A take of the person's own asks "Still
 *   working?" after ten idle minutes, and hands back two minutes later
 *   (`timeout`).
 * - **Interruptions pause.** Closing the surface (or the tab) keeps the person
 *   in control, unattended; opening it again resumes it.
 */

export type TakeoverClient = Pick<TaviClient, "liveWatch">;

export interface TakeoverProps {
  readonly client: TakeoverClient;
  readonly taskId: string;
  /** The session, by its live-view id. */
  readonly sessionId: string;
  /** The agent's request, when it asked: its instructions and deadline. */
  readonly handoff?: { readonly instructions?: string; readonly deadlineAt?: string; readonly reason?: string };
  /** Closes the surface; the person keeps control unless they handed back. */
  readonly onClose: () => void;
  /** Stops the task the session belongs to. */
  /** Stops the task; answers why it could not be, or `undefined` once it was. */
  readonly onStopTask?: (() => Promise<string | undefined>) | undefined;
  /** Stop's label, which says what it ends (`stopLabel`): "Stop the agent" when absent. */
  readonly stopLabel?: string;
  /** Milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** Idle this long, a take of the person's own asks whether they are still at it. */
export const TAKEOVER_IDLE_MS = 10 * 60_000;
/** Unanswered this long, it hands back as `timeout`. */
export const TAKEOVER_STILL_WORKING_MS = 2 * 60_000;

export function Takeover({ client, taskId, sessionId, handoff, onClose, onStopTask, stopLabel, now = Date.now }: TakeoverProps) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const id = useId();
  /** The overlay: modal over the page, so the page behind it is inert and focus returns to it on close. */
  const overlay = useRef<HTMLDivElement>(null);
  useModalFocus(true, overlay);
  const keepControl = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>("taking");
  /** The phase, for the watch's callbacks. */
  const phaseRef = useRef<Phase>("taking");
  phaseRef.current = phase;

  const [picture, setPicture] = useState<Picture>();
  const [location, setLocation] = useState<{ url?: string; title?: string }>({});
  const [picker, setPicker] = useState<Extract<BrowserLiveMessage, { kind: "select" }>>();
  const [dialog, setDialog] = useState<Extract<BrowserLiveMessage, { kind: "dialog" }>>();
  const [chooser, setChooser] = useState<Extract<BrowserLiveMessage, { kind: "chooser" }>>();
  const [uploading, setUploading] = useState<string>();
  const [dialogText, setDialogText] = useState("");
  const [said, setSaid] = useState("");
  const [failure, setFailure] = useState<string>();
  const [handing, setHanding] = useState<"done" | "failed">();
  const [note, setNote] = useState("");
  // The clock: time left, and the idle check.
  const clock = useNow(1000, true, now);
  const [stillWorking, setStillWorking] = useState(false);
  /** The "Still working?" hand-back was tried: it is not tried again every second. */
  const timedOut = useRef(false);
  /** A finger on the picture: where it went down, where it last was, and whether it has become a drag. */
  const touch = useRef<TouchState | undefined>(undefined);
  /** The session was waiting for a person when this surface opened it. */
  const [requested, setRequested] = useState(false);
  const [sessionDeadline, setSessionDeadline] = useState<string>();
  /** This surface is handing back: its own announcement says so. */
  const handingBack = useRef(false);
  const watch = useRef<LiveWatch | undefined>(undefined);
  const batcher = useRef<InputBatcher | undefined>(undefined);
  const lastInput = useRef(now());
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const held = useRef<"left" | "middle" | "right" | undefined>(undefined);
  const lastDown = useRef<{ at: number; x: number; y: number; count: number }>({ at: 0, x: 0, y: 0, count: 0 });

  // Cleared then said a moment later, so the same sentence twice is read twice; a later one, or leaving, cancels it.
  const saying = useRef<number | undefined>(undefined);
  const announce = (text: string): void => {
    setSaid("");
    window.clearTimeout(saying.current);
    saying.current = window.setTimeout(() => setSaid(text), 30);
  };
  useEffect(() => () => window.clearTimeout(saying.current), []);

  const control = async (request: Parameters<LiveWatch["control"]>[0]): Promise<boolean> => {
    const open = watch.current;
    if (open === undefined) return false;
    const answer = await open.control(request);
    if (!answer.ok) setFailure(refusal(answer, t("takeover.page.refused")));
    return answer.ok;
  };

  /** The stream's width: the surface's, at the screen's pixel ratio. */
  const streamWidth = (): number =>
    Math.min(
      BROWSER_LIVE_CONTROL_MAX_WIDTH,
      Math.round((surface.current?.clientWidth || window.innerWidth) * (window.devicePixelRatio || 1)),
    );

  /**
   * A phone holding the page: the size it is laid out at, the surface's own, so it is drawn at its real size rather
   * than a desktop page scaled to a third. Elsewhere the page keeps the session's size.
   */
  const phoneViewport = (): BrowserLivePhoneViewport | undefined => {
    if (!isPhone()) return undefined;
    const within = (value: number, max: number): number => Math.min(max, Math.max(BROWSER_LIVE_PHONE_MIN_SIZE, Math.round(value)));
    return {
      width: within(surface.current?.clientWidth || window.innerWidth, BROWSER_LIVE_PHONE_MAX_WIDTH),
      height: within(surface.current?.clientHeight || window.innerHeight, BROWSER_LIVE_PHONE_MAX_HEIGHT),
    };
  };
  /** What a take asks for: frames as wide as the surface, and on a phone the page at the surface's size. */
  /** The layout size the last take asked for, to ask again only when the surface's differs. */
  const askedViewport = useRef<string | undefined>(undefined);
  const takeOptions = (): { readonly maxWidth: number; readonly viewport?: BrowserLivePhoneViewport } => {
    const viewport = phoneViewport();
    askedViewport.current = JSON.stringify(viewport);
    return { maxWidth: streamWidth(), ...(viewport === undefined ? {} : { viewport }) };
  };

  useTakeoverWatch({
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
  });

  // Once the person holds the page, and whenever the window crosses the phone width, the page follows the surface: laid
  // out at its size on a phone (the bar may have grown a line since the take), or back at its own. Not on every resize:
  // a phone's keyboard changing the height must not lay the page out again.
  const phone = usePhone();
  useEffect(() => {
    if (phase !== "control" || JSON.stringify(phoneViewport()) === askedViewport.current) return;
    void control({ action: "take", sessionId, ...takeOptions() });
  }, [phone, phase]);

  // The agent's own request: its time left shows. A grab of the person's own (even one the agent then waited on) gets the idle check instead.
  const asked = requested || (handoff !== undefined && handoff.reason !== "operator");
  const deadlineAt = handoff?.deadlineAt ?? sessionDeadline;
  const deadline = !asked || deadlineAt === undefined ? undefined : Date.parse(deadlineAt);
  const left = deadline === undefined ? undefined : deadline - clock;
  const idleFor = clock - lastInput.current;
  useEffect(() => {
    if (phase !== "control" || asked) return;
    if (!stillWorking && idleFor >= TAKEOVER_IDLE_MS) {
      setStillWorking(true);
      announce(t("takeover.page.stillWorkingSaid"));
    } else if (stillWorking && !timedOut.current && idleFor >= TAKEOVER_IDLE_MS + TAKEOVER_STILL_WORKING_MS) {
      timedOut.current = true;
      void handBack("timeout");
    }
  }, [clock, phase]);

  // The page's own dropdown, drawn here: focus goes to its chosen option (or its first) as it opens.
  const pickerBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picker === undefined) return;
    const box = pickerBox.current;
    (
      box?.querySelector<HTMLButtonElement>("button[aria-current='true']:not(:disabled)") ??
      box?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();
  }, [picker]);
  /** Arrows move through its options; Escape closes it, back to the page. */
  const pickerKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(undefined);
      surface.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(pickerBox.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  // A timeout warning: focus goes to its one way out, so it is read and answered with a key.
  useEffect(() => {
    if (stillWorking) keepControl.current?.focus();
  }, [stillWorking]);

  const handBack = async (outcome: "done" | "failed" | "timeout", text?: string): Promise<void> => {
    handingBack.current = true;
    // Everything typed reaches the page before it is handed back.
    await batcher.current?.drain();
    const trimmed = text?.trim().slice(0, BROWSER_LIVE_NOTE_MAX);
    if (await control({ action: "release", sessionId, outcome, ...(trimmed === undefined || trimmed === "" ? {} : { note: trimmed }) })) {
      setPhase("released");
      announce(
        outcome === "done" ? t("takeover.page.handedBack") : outcome === "failed" ? t("takeover.page.toldFailed") : t("takeover.page.back"),
      );
      onClose();
    } else handingBack.current = false;
  };

  /** The person's files, to the page's chooser: chunk after chunk, in order, then gone from here. */
  const sendFiles = async (files: readonly File[]): Promise<void> => {
    const open = chooser;
    if (open === undefined) return;
    const refusal = uploadRefusal(files, open.multiple);
    if (refusal !== undefined) {
      setFailure(refusal);
      return;
    }
    setFailure(undefined);
    for (const [index, file] of files.entries()) {
      setUploading(t("takeover.page.sending", { name: file.name, index: index + 1, total: files.length }));
      const chunks = uploadChunks(new Uint8Array(await file.arrayBuffer()));
      for (const [position, chunk] of chunks.entries()) {
        const sent = await control({
          action: "upload",
          sessionId,
          count: files.length,
          index,
          name: file.name.slice(0, 255) || "file",
          type: file.type.slice(0, 127),
          size: file.size,
          offset: chunk.offset,
          data: chunk.data,
        });
        if (!sent) {
          setUploading(undefined);
          // The last piece is the one that hands them over: refused there, the page's chooser is gone.
          if (index === files.length - 1 && position === chunks.length - 1) setChooser(undefined);
          return;
        }
      }
    }
    setUploading(undefined);
    setChooser(undefined);
    const name = files.length === 1 ? files[0]?.name : undefined;
    announce(
      files.length !== 1
        ? t("takeover.page.filesHanded", { count: files.length })
        : name === undefined
          ? t("takeover.page.fileHandedUnnamed")
          : t("takeover.page.fileHanded", { name }),
    );
  };

  const { push, onPointer, onWheel, sendKey, onKey } = surfaceInput({
    phase,
    now,
    stillWorking,
    setStillWorking,
    lastInput,
    batcher,
    picture,
    image,
    surface,
    typing,
    touch,
    held,
    lastDown,
  });

  return (
    <div
      ref={overlay}
      tabIndex={-1}
      className={`takeover takeover-${phase === "control" ? "operator" : "agent"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
    >
      <TakeoverBar
        id={id}
        phase={phase}
        location={location}
        left={left}
        watching={watch.current !== undefined}
        onTake={() => void control({ action: "take", sessionId, ...takeOptions() }).then((ok) => ok && setPhase("control"))}
        onHand={setHanding}
        onStop={onStopTask === undefined ? undefined : () => void onStopTask().then((why) => why !== undefined && setFailure(why))}
        stopLabel={stopLabel ?? t("takeover.stop.agent")}
        onClose={onClose}
      />
      {handoff?.instructions === undefined ? null : <p className="takeover-instructions">{handoff.instructions}</p>}
      {left !== undefined && left <= TAKEOVER_DEADLINE_WARNING_MS && left > 0 ? (
        <Notice role="status">{t("takeover.page.twoMinutes")}</Notice>
      ) : null}
      {stillWorking ? (
        <Notice as="div" role="alertdialog" aria-labelledby={`${id}-still`} aria-describedby={`${id}-still-why`}>
          <span id={`${id}-still`}>{t("takeover.page.stillWorking")}</span>{" "}
          <span id={`${id}-still-why`} className="visually-hidden">
            {t("takeover.page.stillWorkingWhy")}
          </span>
          <Button
            ref={keepControl}
            onClick={() => {
              lastInput.current = now();
              setStillWorking(false);
              surface.current?.focus();
            }}
          >
            {t("takeover.page.keepControl")}
          </Button>
        </Notice>
      ) : null}
      <Failure message={failure} />
      {handing === undefined ? null : (
        <NoteForm
          id={`${id}-note`}
          className="takeover-note"
          label={handing === "done" ? t("takeover.page.anything") : t("takeover.page.whatWentWrong")}
          note={note}
          onNote={setNote}
          submit={handing === "done" ? t("takeover.page.handBack") : t("takeover.note.tellTavi")}
          submitClassName="button-primary"
          onSubmit={() => void handBack(handing, note)}
          onCancel={() => setHanding(undefined)}
        />
      )}
      <div
        className="takeover-page"
        ref={surface}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role=application is the interactive surface that takes the person's keys and pointer
        tabIndex={0}
        role="application"
        aria-label={t("takeover.page.surface")}
        onKeyDown={onKey("down")}
        onKeyUp={onKey("up")}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text === "") return;
          event.preventDefault();
          for (const piece of textEvents(text)) push(piece);
        }}
      >
        {picture === undefined ? (
          <p className="muted">{t("takeover.page.waiting")}</p>
        ) : (
          <img
            ref={image}
            src={picture.src}
            alt={location.title ?? t("takeover.page.image")}
            draggable={false}
            onPointerDown={onPointer("down")}
            onPointerMove={onPointer("move")}
            onPointerUp={onPointer("up")}
            onPointerCancel={onPointer("cancel")}
            onWheel={onWheel}
            onContextMenu={(event) => event.preventDefault()}
          />
        )}
        {/* A phone's keyboard comes up for a focused text field: this one, kept out of sight. */}
        <textarea
          ref={typing}
          className="takeover-typing"
          aria-label={t("takeover.page.typing")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value=""
          onChange={() => undefined}
          onKeyDown={(event) => {
            // Keys that make no text (Backspace, Enter, the arrows) go as keys, once; text comes through input.
            event.stopPropagation();
            if (event.key.length > 1) sendKey(event, "down");
          }}
          onKeyUp={(event) => {
            event.stopPropagation();
            if (event.key.length > 1) sendKey(event, "up");
          }}
          onInput={(event) => {
            const native = event.nativeEvent as InputEvent;
            if (native.isComposing) return;
            const text = (event.target as HTMLTextAreaElement).value || native.data || "";
            for (const piece of textEvents(text)) push(piece);
            (event.target as HTMLTextAreaElement).value = "";
          }}
          onCompositionEnd={(event) => {
            for (const piece of textEvents(event.data)) push(piece);
            (event.target as HTMLTextAreaElement).value = "";
          }}
        />
      </div>
      {picker === undefined ? null : (
        <TakeoverPicker
          picker={picker}
          boxRef={pickerBox}
          onKeyDown={pickerKeys}
          onPick={(value) => {
            setPicker(undefined);
            void control({ action: "select", sessionId, ref: picker.ref, value });
          }}
          onCancel={() => {
            setPicker(undefined);
            surface.current?.focus();
          }}
        />
      )}
      {chooser === undefined || phase !== "control" ? null : (
        <TakeoverChooser
          id={id}
          chooser={chooser}
          uploading={uploading}
          onFiles={(chosen) => void sendFiles(chosen)}
          onCancel={() => {
            setChooser(undefined);
            void control({ action: "upload-cancel", sessionId });
          }}
        />
      )}
      {dialog === undefined ? null : (
        <TakeoverDialog
          id={id}
          dialog={dialog}
          text={dialogText}
          onText={setDialogText}
          onOk={() => {
            setDialog(undefined);
            void control({ action: "dialog", sessionId, accept: true, ...(dialog.type === "prompt" ? { text: dialogText } : {}) });
          }}
          onCancel={() => {
            setDialog(undefined);
            void control({ action: "dialog", sessionId, accept: false });
          }}
        />
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
