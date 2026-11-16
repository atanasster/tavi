import { formatElapsed } from "../../lib/time.js";
import { reduceModelName } from "../../lib/model-name.js";
import { Icon } from "../../ui/Icon.js";
import { MEASURED, type MeasuredName } from "./metrics.js";
import type { SessionStats } from "./shell.js";
import { Button } from "../../ui/Button.js";

/**
 * The one home for numbers: elapsed from the owner's own `at` stamps,
 * tool calls from the transcript, and the workspace's target. Tokens, cost,
 * context % and tok/s are absent, never estimated — `metrics.ts` holds the
 * list and the reason for each, and
 * `MEASURED` names what this renders so the two cannot drift.
 */
export function StatsStrip({
  stats,
  target,
  unconfigured = false,
  afterRestart,
  unreadable,
  chat = true,
  onHelp,
}: {
  readonly stats: SessionStats | undefined;
  /** What the owner runs, as `connection/model`. */
  readonly target: string | undefined;
  /** The owner runs no configured model: not the same claim as "there is no default". */
  readonly unconfigured?: boolean;
  /** What a restart would run instead, while that differs from `target`. */
  readonly afterRestart?: string | undefined;
  /** The target could not be read: not the same claim as "there is no default". */
  readonly unreadable?: boolean;
  /** Whether a chat is on screen: off it (the Center, Settings) elapsed and tool calls would be a hidden chat's, so only the target shows. */
  readonly chat?: boolean;
  /** Opens the `Cmd+/` sheet: its chord is the browser's to overrule, so it is reachable without it. */
  readonly onHelp?: () => void;
}) {
  // One cell per figure `MEASURED` names, in its order: the list is what the
  // page renders, not a parallel description of it.
  const shown: Readonly<Record<MeasuredName, string>> = {
    elapsed: `elapsed ${stats?.elapsedMs === undefined ? "—" : formatElapsed(stats.elapsedMs)}`,
    "tool calls": `${stats === undefined ? 0 : (stats.tools ?? "—")} ${stats?.tools === 1 ? "tool call" : "tool calls"}`,
    // The model's own name: the full `connection/model` is the cell's title.
    Model: `Model: ${unreadable === true ? "unreadable" : target !== undefined ? reduceModelName(target) : unconfigured ? "not configured" : "—"}${unreadable !== true && afterRestart !== undefined ? ` (${reduceModelName(afterRestart)} after restart)` : ""}`,
  };
  const titles: Partial<Record<MeasuredName, string | undefined>> = {
    Model:
      unreadable === true ? undefined : [target, afterRestart && `${afterRestart} after restart`].filter(Boolean).join(" · ") || undefined,
  };
  return (
    <footer className="strip">
      {MEASURED.filter((figure) => chat || figure.name === "Model").map((figure) => (
        <span key={figure.name} title={titles[figure.name]}>
          {shown[figure.name]}
          {/* The title is for a pointer; a keyboard or screen reader hears the full id too. */}
          {titles[figure.name] === undefined ? null : <span className="visually-hidden"> ({titles[figure.name]})</span>}
        </span>
      ))}
      {onHelp === undefined ? null : (
        <Button className="strip-keys" onClick={onHelp} aria-keyshortcuts="Meta+/">
          <Icon name="keyboard" size="sm" />
          {/* Named by what it shows (WCAG 2.5.3), the rest of the name said, not shown. */}
          <span className="strip-keys-label">Keyboard</span>
          <span className="visually-hidden"> shortcuts</span>
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the kbd is not focusable; the button states the shortcut in aria-keyshortcuts */}
          <kbd aria-hidden="true">Cmd+/</kbd>
        </Button>
      )}
    </footer>
  );
}
