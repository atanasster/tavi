import type { HeartbeatItemAnswer } from "@tavi/contracts";
import { useEffect, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { Failure } from "../../ui/Parts.js";
import { getHeartbeatItem, heartbeatItemOp } from "./heartbeat-api.js";
import { localTime, whenLocal } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * A heartbeat item's card, the same in
 * Home and in the Center: its title, the body's first line (the rest behind
 * More), where it came from and which instruction line it answers, and its
 * actions — *Do it* (only with a proposal), *Chat about this*, *Snooze for a
 * day*, *Don't tell me about this*, *Useful* and *Not useful*. A resolved, snoozed or
 * muted item collapses to a one-line receipt. Read on its own (Home), it names up to two
 * memories the check that told it was given ("Because you said …").
 */

export type HeartbeatItemView = HeartbeatItemAnswer["item"];

const DAY_MINUTES = 24 * 60;

/** The one-line receipt of an item that no longer waits, or undefined for one that does. */
export function itemReceipt(item: HeartbeatItemView, timeZone: string | undefined, now = Date.now()): string | undefined {
  if (item.state === "resolved") return `Resolved · ${localTime(item.updatedAt, timeZone)}`;
  if (item.state === "muted") return "Muted: you won't hear about this again";
  if (item.state === "snoozed" && item.snoozedUntil !== undefined && Date.parse(item.snoozedUntil) > now)
    return `Snoozed until ${whenLocal(item.snoozedUntil, timeZone, now)}`;
  return undefined;
}

export function HeartbeatItemCard({
  itemId,
  initial,
  timeZone,
  connected = true,
  onDoIt,
  onChat,
}: {
  readonly itemId: string;
  /** The item when the list that shows it already read it; absent, the card reads it. */
  readonly initial?: HeartbeatItemView | undefined;
  readonly timeZone: string | undefined;
  readonly connected?: boolean;
  /** *Do it*: an attended turn the owner seeds from the proposal. */
  readonly onDoIt?: ((item: HeartbeatItemView) => void) | undefined;
  /** *Chat about this*: a turn quoting the item. */
  readonly onChat?: ((item: HeartbeatItemView) => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const [item, setItem] = useState<HeartbeatItemView | undefined>(initial);
  /** The memories the check that told it was given: read with the item, never from a list's copy. */
  const [because, setBecause] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  // A list's copy replaces what is shown each time it changes; without one, the item is read.
  useResetOnChange([initial], () => {
    if (initial !== undefined) setItem(initial);
  });
  useEffect(() => {
    if (initial !== undefined) return;
    let current = true;
    void getHeartbeatItem(client, workspaceId, itemId).then((outcome) => {
      if (!current) return;
      if (outcome.ok) {
        setItem(outcome.value.item);
        setBecause(outcome.value.because ?? []);
      } else setFailure(outcome.message);
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, itemId, initial]);

  if (item === undefined) return <Failure message={failure} alert={false} />;
  const act = (op: Parameters<typeof heartbeatItemOp>[3]): void => {
    void heartbeatItemOp(client, workspaceId, item.itemId, op).then((outcome) => {
      if (outcome.ok) {
        setItem(outcome.value.item);
        setFailure(undefined);
      } else setFailure(outcome.message);
    });
  };
  const receipt = itemReceipt(item, timeZone);
  const sources = item.sources.map((source) => source.label).join(", ");
  const [first = "", ...rest] = (item.body ?? "").split("\n");
  return (
    <article className="heartbeat-item" data-urgency={item.urgency} aria-label={`Heartbeat: ${item.title}`}>
      <p className="heartbeat-item-title">{item.title}</p>
      {receipt === undefined ? (
        <>
          {first === "" ? null : (
            <p className="heartbeat-item-body">
              {first}
              {rest.length === 0 ? null : expanded ? (
                <>
                  <br />
                  {rest.join("\n")}
                </>
              ) : null}
              {rest.length === 0 ? null : (
                <Button variant="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                  {expanded ? " Less" : " More"}
                </Button>
              )}
            </p>
          )}
          <p className="meta-sm heartbeat-item-source">
            {sources} · {localTime(item.lastToldAt, timeZone)}
            {item.instructionLine === undefined ? "" : ` · from your line ${item.instructionLine}`}
            {item.heldBack ? " · held back (hourly limit)" : ""}
          </p>
          {because.length === 0 ? null : (
            <p className="meta-sm heartbeat-item-because">Because you said: {because.map((title) => `“${title}”`).join(", ")}</p>
          )}
          <div className="heartbeat-actions cluster">
            {item.proposedAction === undefined || onDoIt === undefined ? null : (
              <Button size="sm" disabled={!connected} title={item.proposedAction.summary} onClick={() => onDoIt(item)}>
                Do it
              </Button>
            )}
            {onChat === undefined ? null : (
              <Button variant="ghost" size="sm" disabled={!connected} onClick={() => onChat(item)}>
                Chat about this
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => act({ op: "snooze", minutes: DAY_MINUTES })}>
              Snooze for a day
            </Button>
            <Button variant="ghost" size="sm" onClick={() => act({ op: "mute" })}>
              Don't tell me about this
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={item.feedback === "up"}
              onClick={() => act({ op: "feedback", feedback: item.feedback === "up" ? null : "up" })}
            >
              Useful
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={item.feedback === "down"}
              onClick={() => act({ op: "feedback", feedback: item.feedback === "down" ? null : "down" })}
            >
              Not useful
            </Button>
          </div>
        </>
      ) : (
        <p className="meta-sm heartbeat-item-receipt">
          {receipt}
          {item.state === "snoozed" ? (
            <>
              {" "}
              <Button variant="link" onClick={() => act({ op: "unsnooze" })}>
                Undo
              </Button>
            </>
          ) : null}
          {item.state === "muted" ? (
            <>
              {" "}
              <Button variant="link" onClick={() => act({ op: "unmute" })}>
                Undo
              </Button>
            </>
          ) : null}
        </p>
      )}
      <Failure message={failure} alert={false} />
    </article>
  );
}
