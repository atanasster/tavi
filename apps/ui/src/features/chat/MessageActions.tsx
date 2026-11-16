import { IconButton } from "../../ui/IconButton.js";
import { ANNOUNCER_ID } from "../shell/a11y.js";
import { useCopied } from "../../hooks/page.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";

let activeSpeech: SpeechSynthesisUtterance | undefined;

/** Rewind never touches files, and its confirmation says so. */
export const REWIND_FOLDER_NOTE = "Files in the chat's folder were not changed.";

/** Rewind offered on a person's message: how many later turns go with it, and the call that takes them back (answers why it did not). */
export interface RewindOffer {
  readonly later: number;
  readonly onRewind: () => Promise<string | undefined>;
}

/** Shared actions for user prompts and assistant responses, including restored turns. */
export function MessageActions({
  text,
  label,
  readAloud = false,
  rewind,
  onRepeat,
}: {
  readonly text: string;
  readonly label: string;
  readonly readAloud?: boolean;
  readonly rewind?: RewindOffer | undefined;
  /** *Repeat this…*: open the schedule form filled from this message; `report` says what was created. */
  readonly onRepeat?: ((report: (note: string) => void) => void) | undefined;
}) {
  const [notice, setNotice] = useState("");
  // The check and the notice make way once they have been seen.
  const { copied, copy } = useCopied({ onReset: () => setNotice(""), failedMs: 6000 });
  const report = (text: string) => {
    setNotice(text);
    const region = document.getElementById(ANNOUNCER_ID);
    if (region) region.textContent = text;
  };
  const [speaking, setSpeaking] = useState(false);
  const [confirming, setConfirming] = useState<"ask" | "rewinding">();
  /** The row, and the confirmation's Rewind button: focus moves between them as the row is swapped. */
  const row = useRef<HTMLDivElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (confirming === "ask" && !asked.current) confirmButton.current?.focus();
    // Back from the confirmation (cancelled, or the rewind refused): focus returns to the button that opened it.
    if (confirming === undefined && asked.current)
      row.current?.querySelector<HTMLButtonElement>('button[aria-label="Rewind to here"]')?.focus();
    asked.current = confirming !== undefined;
  }, [confirming]);
  const utterance = useRef<SpeechSynthesisUtterance | undefined>(undefined);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  useEffect(() => {
    const reset = () => setSpeaking(false);
    window.addEventListener("tavi:speech", reset);
    return () => {
      window.removeEventListener("tavi:speech", reset);
      if (utterance.current && activeSpeech === utterance.current) {
        window.speechSynthesis.cancel();
        activeSpeech = undefined;
      }
    };
  }, []);
  const speak = () => {
    if (!supported) return;
    const stop = speaking;
    activeSpeech = undefined;
    window.speechSynthesis.cancel();
    window.dispatchEvent(new Event("tavi:speech"));
    if (stop) return;
    // Short utterances keep long responses readable on browser speech engines.
    const chunks = text.match(/[\s\S]{1,240}(?:\s|$)|[\s\S]{1,240}/g) ?? [];
    const nextChunk = () => {
      const chunk = chunks.shift();
      if (!chunk) {
        activeSpeech = undefined;
        setSpeaking(false);
        return;
      }
      const next = new SpeechSynthesisUtterance(chunk);
      utterance.current = next;
      activeSpeech = next;
      next.onend = () => {
        if (activeSpeech === next) nextChunk();
      };
      next.onerror = () => {
        if (activeSpeech === next) {
          activeSpeech = undefined;
          setSpeaking(false);
          report("Read aloud stopped or unavailable.");
        }
      };
      setSpeaking(true);
      try {
        window.speechSynthesis.speak(next);
      } catch {
        activeSpeech = undefined;
        setSpeaking(false);
        report("Read aloud is unavailable.");
      }
    };
    nextChunk();
  };
  if (confirming !== undefined && rewind !== undefined) {
    const goes =
      rewind.later === 0
        ? "This message and Tavi's answer are taken back"
        : `This message, Tavi's answer and ${rewind.later} later ${rewind.later === 1 ? "turn are" : "turns are"} taken back`;
    const confirm = () => {
      setConfirming("rewinding");
      void rewind.onRewind().then(
        (failed) => {
          setConfirming(undefined);
          if (failed !== undefined) report(failed);
        },
        () => {
          setConfirming(undefined);
          report("Rewind failed.");
        },
      );
    };
    return (
      <div className="message-actions rewind-confirm" role="group" aria-label="Rewind to here" ref={row}>
        <span className="meta-sm">
          {goes}; the message returns to the box to edit. {REWIND_FOLDER_NOTE}
        </span>
        <Button size="sm" ref={confirmButton} disabled={confirming === "rewinding"} onClick={confirm}>
          {confirming === "rewinding" ? "Rewinding…" : "Rewind"}
        </Button>
        <Button variant="ghost" size="sm" disabled={confirming === "rewinding"} onClick={() => setConfirming(undefined)}>
          Cancel
        </Button>
      </div>
    );
  }
  // Tooltips open below the row: above would cover the message they belong to.
  return (
    <div className="message-actions" ref={row}>
      <IconButton
        icon={copied ? "check" : "copy"}
        label={`Copy ${label}`}
        tooltip={copied ? "Copied" : `Copy ${label}`}
        tooltipPlacement="bottom"
        onClick={() => copy(text, (ok) => report(ok ? "Copied" : "Copy unavailable. Select the text to copy it."))}
      />
      {readAloud ? (
        <IconButton
          icon={speaking ? "stop" : "speaker"}
          label={speaking ? "Stop reading" : "Read aloud"}
          disabled={!supported}
          tooltip={supported ? (speaking ? "Stop reading" : "Read this response aloud") : "Read aloud is unavailable in this browser"}
          tooltipPlacement="bottom"
          aria-pressed={speaking}
          onClick={speak}
        />
      ) : null}
      {rewind === undefined ? null : (
        <IconButton
          icon="rewind"
          label="Rewind to here"
          tooltip="Rewind to here: take back this message and what came after, and edit it"
          tooltipPlacement="bottom"
          onClick={() => setConfirming("ask")}
        />
      )}
      {onRepeat === undefined ? null : (
        <IconButton
          icon="calendar"
          label="Repeat this…"
          tooltip="Repeat this: run it on a schedule"
          tooltipPlacement="bottom"
          aria-haspopup="dialog"
          onClick={() => onRepeat(report)}
        />
      )}
      <span className="action-notice meta-sm">{notice}</span>
    </div>
  );
}
