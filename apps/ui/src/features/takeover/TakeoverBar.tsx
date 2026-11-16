import { hostOf } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { formatLeft } from "./input.js";
import type { Phase } from "./use-takeover-watch.js";

/** The agent's request warns this long before it runs out. */
export const TAKEOVER_DEADLINE_WARNING_MS = 2 * 60_000;

/**
 * The takeover's own bar: where it stands, the page's address, the time the
 * agent's request leaves, and taking control, handing back, stopping the task
 * and closing.
 */
export function TakeoverBar({
  id,
  phase,
  location,
  left,
  watching,
  onTake,
  onHand,
  onStop,
  stopLabel,
  onClose,
}: {
  /** The surface's id prefix: the bar holds its title. */
  readonly id: string;
  readonly phase: Phase;
  readonly location: { readonly url?: string; readonly title?: string };
  /** Milliseconds the agent's request has left, when it set a deadline. */
  readonly left: number | undefined;
  /** The watch is open: a failed take can be tried again. */
  readonly watching: boolean;
  readonly onTake: () => void;
  readonly onHand: (outcome: "done" | "failed") => void;
  /** Stops the task, where it can be. */
  readonly onStop: (() => void) | undefined;
  readonly stopLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <div className="takeover-bar">
      <div className="takeover-where">
        <strong id={`${id}-title`}>
          {phase === "control"
            ? "You're in control — Tavi is paused"
            : phase === "pending" || phase === "taking"
              ? "Taking control after the current step…"
              : phase === "elsewhere"
                ? "Controlled in another tab"
                : phase === "unattended"
                  ? "You still have control"
                  : phase === "released"
                    ? "Tavi has the browser"
                    : "The browser could not be taken over"}
        </strong>
        <span className="muted"> · Tavi doesn't see what you type</span>
        <span className="takeover-address truncate">
          {hostOf(location.url, "")}
          {location.title === undefined ? "" : ` — ${location.title}`}
        </span>
        {left === undefined ? null : (
          <span className={left <= TAKEOVER_DEADLINE_WARNING_MS ? "takeover-left warning" : "takeover-left"}>{formatLeft(left)} left</span>
        )}
      </div>
      <div className="takeover-actions">
        {phase === "elsewhere" || phase === "unattended" || (phase === "failed" && watching) ? (
          <Button variant="primary" onClick={onTake}>
            {phase === "unattended" ? "Resume control" : "Take control here"}
          </Button>
        ) : null}
        {phase === "control" ? (
          <>
            <Button variant="primary" onClick={() => onHand("done")}>
              Done — hand back
            </Button>
            <Button onClick={() => onHand("failed")}>Couldn't do it</Button>
          </>
        ) : null}
        {onStop === undefined ? null : (
          <Button variant="danger" onClick={onStop}>
            {stopLabel}
          </Button>
        )}
        <Button aria-label={phase === "control" ? "Close (you keep control)" : "Close"} onClick={onClose}>
          ×
        </Button>
      </div>
    </div>
  );
}
