import {
  CLIENT_PROTOCOL_VERSION,
  ClientEventSchema,
  approvalTitleOf,
  SCHEDULE_NOTHING_TO_REPORT,
  boundEventPayloads,
  clipText,
  displaySafe,
  isNothingToReport,
  isUnifiedDiff,
  type ClientEvent,
  type UnsequencedClientEvent,
  encodeClientEvent,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { terminalText } from "../../shared/terminal-text.js";
import { shownInput } from "../approvals/prompt.js";

/**
 * Client event sink.
 *
 * Every event carries the protocol version, stream epoch, run identity, attempt
 * identity and a monotonically increasing sequence within that epoch. The sink
 * assigns the sequence, so no producer can emit an unordered stream.
 */

export interface ClientEventSink {
  readonly emit: (event: UnsequencedClientEvent) => void;
  readonly epoch: string;
  readonly count: number;
}

export function createClientEventSink(options: {
  readonly epoch: string;
  readonly onEvent: (event: ClientEvent) => void;
  readonly now?: () => string;
}): ClientEventSink {
  let sequence = 0;
  const now = options.now ?? nowTimestamp;

  const sink = {
    epoch: options.epoch,
    get count(): number {
      return sequence;
    },
    emit(event: UnsequencedClientEvent): void {
      const { at, ...rest } = event;
      const bounded = boundEventPayloads(rest as Record<string, unknown>);
      // Validated where it is produced, not only where it is consumed: an invalid
      // event must never reach a client.
      const envelope = ClientEventSchema.parse({
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        epoch: options.epoch,
        sequence,
        at: at ?? now(),
        ...bounded,
      });
      sequence += 1;
      options.onEvent(envelope);
    },
  };
  return sink;
}

export interface EventRendererOptions {
  readonly format: "text" | "json";
  readonly write: (chunk: string) => void;
  /**
   * A schedule's fire: an answer that is exactly `[nothing to report]` is
   * printed as `nothing to report`, as the marker is never posted or alerted.
   * Text that could still become the marker is held until it cannot.
   */
  readonly quietMarker?: boolean;
}

/** What a terminal prints for a fire's `[nothing to report]` answer (AUTOMATION.md). */
const NOTHING_TO_REPORT_TEXT = "nothing to report";

/** A fire's final text as a terminal prints it: the quiet marker in words, any other text as it is. */
export function fireFinalText(finalText: string): string {
  return isNothingToReport(finalText) ? NOTHING_TO_REPORT_TEXT : finalText;
}

/**
 * Renders client events for a terminal.
 *
 * `text` mode streams model deltas live and prints tool/approval transitions;
 * `json` mode emits one validated event per line for machine consumers.
 */
export function createEventRenderer(options: EventRendererOptions): {
  readonly render: (event: ClientEvent) => void;
  readonly finish: () => void;
} {
  let wroteDelta = false;
  /** Under `quietMarker`: the current text's start while it could still be the whole marker. */
  let held = "";
  /** This stretch of text can no longer be the marker: its deltas print as they come. */
  let passing = false;
  /** The held text printed: the marker in words once the answer ended on it, as it was otherwise. */
  const release = (ended: boolean): void => {
    if (held === "") return;
    options.write(ended && isNothingToReport(held) ? NOTHING_TO_REPORT_TEXT : held);
    wroteDelta = true;
    held = "";
  };

  return {
    render(event: ClientEvent): void {
      if (options.format === "json") {
        options.write(`${encodeClientEvent(event)}\n`);
        return;
      }
      if (options.quietMarker === true) {
        if (event.kind === "text.delta" && !passing) {
          held += event.text;
          if (SCHEDULE_NOTHING_TO_REPORT.startsWith(held.trim().toLowerCase())) return;
          passing = true;
          release(false);
          return;
        }
        if (event.kind !== "text.delta") {
          // Anything but text ends the stretch: it was the whole answer only when the task completed on it.
          release(event.kind === "task.completed");
          passing = false;
        }
      }
      switch (event.kind) {
        case "text.delta":
          wroteDelta = true;
          options.write(event.text);
          break;
        case "task.spawned":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(`[spawned] ${event.workerAgentId}: ${event.childRunId} (depth ${event.depth})\n`);
          break;
        case "tool.started":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(`[tool] ${event.toolName} ← ${safe(event.input)}\n`);
          break;
        case "tool.completed":
          options.write(`[tool] ${event.toolName} → ${safe(event.output)} (${formatMs(event.durationMs)})\n`);
          break;
        case "tool.failed":
          options.write(`[tool] ${event.toolName} failed: ${event.message}\n`);
          break;
        case "approval.required":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(approvalText(event));
          break;
        case "approval.settled":
          options.write(`[approval] ${settledText(event)}\n`);
          break;
        case "attempt.replaced":
          // On its own line: a failed-over call may have streamed half a line.
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(
            event.discarded === true
              ? `[attempt] ${event.reason} — the text above from ${event.supersededAttemptId} is not the answer\n`
              : // The round may have been denied: the line above says how it was decided.
                `[attempt] replaced ${event.supersededAttemptId}: ${event.reason === "resuming after approval" ? "resuming after the decision" : event.reason}\n`,
          );
          break;
        case "turn.steered":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(`[steer] ${event.text}\n`);
          break;
        case "plugin.notice":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(`[plugin] ${terminalText(event.pluginId)}: ${terminalText(event.notice)}\n`);
          break;
        case "turn.suggested":
          if (wroteDelta) options.write("\n");
          wroteDelta = false;
          options.write(`[suggested] ${event.suggestions.map(terminalText).join(" · ")}\n`);
          break;
        case "task.failed":
          options.write(`\n[task failed] ${event.errorCode}: ${event.message}\n`);
          break;
        case "task.stopped":
          options.write(`\n[stopped] ${event.message}\n`);
          break;
        case "resync.required":
          options.write(`[resync] ${event.reason}\n`);
          break;
        default:
          break;
      }
    },
    finish(): void {
      release(true);
      if (wroteDelta) options.write("\n");
      wroteDelta = false;
    },
  };
}

/** How many lines of a file change's diff an approval prints, as `tavi chat` prints them. */
const APPROVAL_DIFF_LINES = 20;

/**
 * A call that needs approval, said once: its title, then a file change's diff
 * (its first lines) or else its input, what either would hide marked.
 */
function approvalText(event: Extract<ClientEvent, { kind: "approval.required" }>): string {
  const title = terminalText(displaySafe(approvalTitleOf(event)));
  const diff = event.display?.detail;
  if (!isUnifiedDiff(diff)) return `[approval] ${title} ${clipText(shownInput(event.input), 400)}\n`;
  const lines = diff.split("\n");
  const shown = lines.slice(0, APPROVAL_DIFF_LINES).map((line) => `  ${terminalText(displaySafe(line))}\n`);
  // Only the diff's own lines are counted: a cut diff's closing note is none.
  const more = lines.slice(APPROVAL_DIFF_LINES).filter((line) => /^[ +\-@]/.test(line)).length;
  const rest =
    lines.length > APPROVAL_DIFF_LINES
      ? [`  … ${more === 0 ? "the rest" : `${more} more lines`} in tavi approvals show ${event.runId}\n`]
      : [];
  return `[approval] ${title}\n${shown.join("")}${rest.join("")}`;
}

/** How a round was decided, and by whom: a run's own `--approval` policy by its flag, a schedule's by its name. */
function settledText(event: Extract<ClientEvent, { kind: "approval.settled" }>): string {
  const approved = event.decisions.filter((decision) => decision.approved).length;
  const denied = event.decisions.length - approved;
  const verdict = denied === 0 ? "approved" : approved === 0 ? "denied" : `${approved} approved, ${denied} denied`;
  const decider = event.decidedBy;
  const by = decider.startsWith("auto:")
    ? `--approval ${denied === 0 ? "approve" : "deny"}`
    : decider.startsWith("schedule:")
      ? `the schedule ${terminalText(decider.slice("schedule:".length))}'s policy`
      : decider === "policy"
        ? "policy"
        : terminalText(decider);
  return `${verdict} by ${by}`;
}

/** Render a sub-millisecond duration without pretending it was exactly zero. */
function formatMs(durationMs: number): string {
  if (durationMs >= 1) return `${durationMs.toFixed(1)}ms`;
  return `${(durationMs * 1000).toFixed(0)}µs`;
}

/** Compact a payload for text-mode rendering. */
function safe(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return "null";
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
}
