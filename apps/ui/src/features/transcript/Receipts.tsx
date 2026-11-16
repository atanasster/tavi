import type { BrowserControlReceipt, SettledWait } from "@tavi/client/browser";
import { formatControlled } from "../takeover/input.js";

export function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** How a person's hold of the browser went, in one line: the same words wherever it is said. */
function controlledText(outcome: "done" | "failed" | "timeout" | "cancelled", controlledMs: number, note: string | undefined): string {
  const said = note === undefined || note === "" ? "" : ` · ${note}`;
  if (controlledMs === 0 && outcome === "failed") return `You told Tavi you couldn't do it${said}`;
  const how =
    outcome === "done"
      ? "done"
      : outcome === "failed"
        ? "couldn't do it"
        : outcome === "timeout"
          ? "handed back when it went idle"
          : "the session ended";
  return `You controlled the browser for ${formatControlled(controlledMs)} — ${how}${said}`;
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
        ? "Nobody took over the browser in time; Tavi carried on"
        : "The browser handoff ended without you";
  return (
    <p className="handoff-receipt meta-base" role="note">
      {text}
    </p>
  );
}
