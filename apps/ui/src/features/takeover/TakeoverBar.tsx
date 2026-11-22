import { hostOf } from "../../lib/format.js";
import { useT } from "../../lib/i18n.js";
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
  const t = useT();
  return (
    <div className="takeover-bar">
      <div className="takeover-where">
        <strong id={`${id}-title`}>
          {phase === "control"
            ? t("takeover.bar.control")
            : phase === "pending" || phase === "taking"
              ? t("takeover.bar.taking")
              : phase === "elsewhere"
                ? t("takeover.bar.elsewhere")
                : phase === "unattended"
                  ? t("takeover.bar.unattended")
                  : phase === "released"
                    ? t("takeover.bar.released")
                    : t("takeover.bar.failed")}
        </strong>
        <span className="muted"> · {t("takeover.bar.unseen")}</span>
        <span className="takeover-address truncate">
          {hostOf(location.url, "")}
          {location.title === undefined ? "" : ` — ${location.title}`}
        </span>
        {left === undefined ? null : (
          <span className={left <= TAKEOVER_DEADLINE_WARNING_MS ? "takeover-left warning" : "takeover-left"}>
            {t("takeover.left", { time: formatLeft(left) })}
          </span>
        )}
      </div>
      <div className="takeover-actions">
        {phase === "elsewhere" || phase === "unattended" || (phase === "failed" && watching) ? (
          <Button variant="primary" onClick={onTake}>
            {phase === "unattended" ? t("takeover.handoff.resume") : t("takeover.bar.takeHere")}
          </Button>
        ) : null}
        {phase === "control" ? (
          <>
            <Button variant="primary" onClick={() => onHand("done")}>
              {t("takeover.bar.done")}
            </Button>
            <Button onClick={() => onHand("failed")}>{t("takeover.bar.couldNot")}</Button>
          </>
        ) : null}
        {onStop === undefined ? null : (
          <Button variant="danger" onClick={onStop}>
            {stopLabel}
          </Button>
        )}
        <Button aria-label={phase === "control" ? t("takeover.bar.closeKeep") : t("takeover.bar.close")} onClick={onClose}>
          ×
        </Button>
      </div>
    </div>
  );
}
