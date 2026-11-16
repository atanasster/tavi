import type { BrowserLiveFrameMetadata, BrowserLiveInputEvent } from "@tavi/contracts";
import type { KeyboardEvent, PointerEvent, RefObject, WheelEvent } from "react";

import { TOUCH_SLOP_PX } from "../../lib/layout.js";
import { buttonOf, keyEventOf, pagePoint, type InputBatcher } from "./input.js";

/** A finger on the picture: where it went down, where it last was, and whether it has become a drag. */
export interface TouchState {
  readonly start: { x: number; y: number };
  last: { x: number; y: number };
  readonly client: { x: number; y: number };
  dragging: boolean;
}

/**
 * The takeover surface's input, built each render from what Takeover holds:
 * pointer, touch, wheel and keys turned into the page's input events and
 * pushed to the batcher, only while the person is in control. A touch's tap
 * is a click and its drag a wheel; any input ends a "Still working?" ask.
 */
export function surfaceInput({
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
}: {
  readonly phase: string;
  readonly now: () => number;
  readonly stillWorking: boolean;
  readonly setStillWorking: (still: boolean) => void;
  readonly lastInput: RefObject<number>;
  readonly batcher: RefObject<InputBatcher | undefined>;
  readonly picture: { readonly metadata: BrowserLiveFrameMetadata } | undefined;
  readonly image: RefObject<HTMLImageElement | null>;
  readonly surface: RefObject<HTMLDivElement | null>;
  readonly typing: RefObject<HTMLTextAreaElement | null>;
  readonly touch: RefObject<TouchState | undefined>;
  readonly held: RefObject<"left" | "middle" | "right" | undefined>;
  readonly lastDown: RefObject<{ at: number; x: number; y: number; count: number }>;
}) {
  const push = (event: BrowserLiveInputEvent | undefined): void => {
    if (event === undefined || phase !== "control") return;
    lastInput.current = now();
    if (stillWorking) setStillWorking(false);
    batcher.current?.push(event);
  };
  const point = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const box = image.current?.getBoundingClientRect();
    return box === undefined || picture === undefined ? undefined : pagePoint(box, clientX, clientY, picture.metadata);
  };
  const onPointer = (action: "move" | "down" | "up" | "cancel") => (event: PointerEvent<HTMLImageElement>) => {
    const at = point(event.clientX, event.clientY);
    if (at === undefined) return;
    event.preventDefault();
    // One finger: a tap is a click, and a drag scrolls the page (a wheel), as on a phone's own browser.
    if (event.pointerType === "touch") {
      // A touch the browser took back (a gesture of its own) is no tap.
      if (action === "cancel") touch.current = undefined;
      else onTouch(action, event, at);
      return;
    }
    if (action === "down") {
      // Focus for the keyboard (a touch screen's hidden field is focused by `onTouch`).
      surface.current?.focus();
      const previous = lastDown.current;
      const again = event.timeStamp - previous.at < 450 && Math.abs(at.x - previous.x) < 6 && Math.abs(at.y - previous.y) < 6;
      lastDown.current = { at: event.timeStamp, x: at.x, y: at.y, count: again ? Math.min(3, previous.count + 1) : 1 };
      // A release outside the picture still comes here, so the page never keeps a button pressed.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      held.current = buttonOf(event.button);
      push({ type: "mouse", action: "down", ...at, button: held.current, clickCount: lastDown.current.count });
      return;
    }
    if (action === "up" || action === "cancel") {
      // A cancelled pointer with no button down sends nothing; with one down, it is let go.
      if (held.current === undefined) return;
      push({ type: "mouse", action: "up", ...at, button: held.current ?? buttonOf(event.button), clickCount: lastDown.current.count });
      held.current = undefined;
      return;
    }
    push({ type: "mouse", action: "move", ...at, ...(held.current === undefined ? {} : { button: held.current }) });
  };
  const onTouch = (action: "move" | "down" | "up", event: PointerEvent<HTMLImageElement>, at: { x: number; y: number }): void => {
    if (action === "down") {
      typing.current?.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      touch.current = { start: at, last: at, client: { x: event.clientX, y: event.clientY }, dragging: false };
      return;
    }
    const held = touch.current;
    if (held === undefined) return;
    if (action === "move") {
      if (!held.dragging && Math.hypot(event.clientX - held.client.x, event.clientY - held.client.y) < TOUCH_SLOP_PX) return;
      held.dragging = true;
      // The page moves with the finger: dragging up scrolls down.
      push({
        type: "wheel",
        ...at,
        deltaX: Math.round((held.last.x - at.x) * 100) / 100,
        deltaY: Math.round((held.last.y - at.y) * 100) / 100,
      });
      held.last = at;
      return;
    }
    touch.current = undefined;
    if (held.dragging) return;
    push({ type: "mouse", action: "down", ...held.start, button: "left", clickCount: 1 });
    push({ type: "mouse", action: "up", ...held.start, button: "left", clickCount: 1 });
  };
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    const at = point(event.clientX, event.clientY);
    if (at === undefined) return;
    push({ type: "wheel", ...at, deltaX: event.deltaX, deltaY: event.deltaY });
  };
  const sendKey = (event: KeyboardEvent<HTMLElement>, action: "down" | "up"): void => {
    event.preventDefault();
    push(
      keyEventOf(
        {
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
        action,
      ),
    );
  };
  const onKey = (action: "down" | "up") => (event: KeyboardEvent<HTMLElement>) => {
    // The surface's own keys only: the bar's controls keep theirs, and the phone's field sends its own.
    if (event.target !== surface.current) return;
    sendKey(event, action);
  };
  return { push, onPointer, onWheel, sendKey, onKey };
}
