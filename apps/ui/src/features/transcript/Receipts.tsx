import type { BrowserControlReceipt, SettledWait } from "@tavi/client/browser";
import { formatControlled } from "../takeover/input.js";
import { translateNow } from "../../lib/i18n.js";

export function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** How a person's hold of the browser went, in one line: the same words wherever it is said. */
function controlledText(outcome: "done" | "failed" | "timeout" | "cancelled", controlledMs: number, note: string | undefined): string {
  const said = note === undefined || note === "" ? "" : ` · ${note}`;
  if (controlledMs === 0 && outcome === "failed") return `${translateNow("transcript.handoff.told")}${said}`;
  const how = translateNow(
    outcome === "done"
      ? "transcript.handoff.done"
      : outcome === "failed"
        ? "transcript.handoff.failed"
        : outcome === "timeout"
          ? "transcript.handoff.timeout"
          : "transcript.handoff.cancelled",
  );
  return `${translateNow("transcript.handoff.controlled", { time: formatControlled(controlledMs), how })}${said}`;
}

/**
 * A person's hold of the browser the task did not wait for, after the
 * turn it followed: the same words as a handoff's receipt.
 */
export function BrowserControlRow({ receipt }: { readonly receipt: BrowserControlReceipt }) {
  return (
    <p className="handoff-receipt meta-base" role="note">
      {controlledText(receipt.outcome, receipt.controlledMs, receipt.note)}
    </p>
  );
}

/**
 * What became of a browser handoff, after the call that waited for it:
 * "You controlled the browser for 1 m 12 s — done · note". The note is the
 * person's own; nothing they typed in the page is here.
 */

export function HandoffReceipt({ receipt }: { readonly receipt: SettledWait }) {
  const text =
    receipt.handoff !== undefined
      ? controlledText(receipt.handoff.outcome, receipt.handoff.controlledMs, receipt.replyText)
      : receipt.outcome === "wait-timeout"
        ? translateNow("transcript.handoff.nobody")
        : translateNow("transcript.handoff.without");
  return (
    <p className="handoff-receipt meta-base" role="note">
      {text}
    </p>
  );
}
