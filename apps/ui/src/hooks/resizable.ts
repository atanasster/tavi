import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { readStored, writeStored } from "../lib/storage.js";

/**
 * A column's width bounds and where it keeps the reader's choice. `side` is
 * the edge of the window the column sits on: a left column grows as the
 * pointer moves right, a right column as it moves left, and the arrow keys
 * follow the handle, not the column.
 */
export interface PanelBounds {
  readonly side: "left" | "right";
  readonly key: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  /** What the rest of the window keeps while the column is dragged wider. */
  readonly reserve: number;
  /** Released below this width, the column closes instead of resizing. */
  readonly snapCollapse?: number | undefined;
}

function clampWidth(width: number, bounds: Pick<PanelBounds, "min" | "max">): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(width)));
}

export function loadWidth(bounds: Pick<PanelBounds, "key" | "min" | "max" | "initial">, storage?: Pick<Storage, "getItem">): number {
  const raw = readStored(bounds.key, storage);
  if (raw === undefined) return bounds.initial;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampWidth(parsed, bounds) : bounds.initial;
}

export function saveWidth(key: string, width: number, storage?: Pick<Storage, "setItem">): void {
  writeStored(key, String(Math.round(width)), storage);
}

/** The widest the column may be in this window, so the rest keeps `reserve`. */
function allowed(bounds: PanelBounds): number {
  const viewport = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1024;
  return Math.min(bounds.max, Math.max(bounds.min, viewport - bounds.reserve));
}

/**
 * Pointer, keyboard and double-click resizing for a column's separator: the
 * width follows the pointer, is saved on release, and Enter, Space or a
 * double-click put it back to `initial`. A release below `snapCollapse`
 * calls `onCollapse` and leaves the saved width as it was.
 */
export function useResizablePanel(
  bounds: PanelBounds,
  options: {
    readonly initialWidth?: number | undefined;
    readonly onWidthChange?: ((width: number) => void) | undefined;
    readonly onCollapse?: (() => void) | undefined;
  } = {},
) {
  const [width, setWidth] = useState(() => options.initialWidth ?? loadWidth(bounds));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const direction = bounds.side === "left" ? 1 : -1;

  const update = (next: number, persist = false) => {
    setWidth(next);
    options.onWidthChange?.(next);
    if (persist) saveWidth(bounds.key, next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    document.body.classList.add("sidebar-resizing");

    const start = dragRef.current;
    const raw = (e: PointerEvent) => start.startWidth + direction * (e.clientX - start.startX);
    const fit = (value: number) => Math.max(bounds.min, Math.min(allowed(bounds), value));

    const finish = () => {
      dragRef.current = null;
      setDragging(false);
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      update(fit(raw(e)));
    };

    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current) {
        const value = raw(e);
        if (bounds.snapCollapse !== undefined && options.onCollapse !== undefined && value < bounds.snapCollapse) {
          update(start.startWidth);
          options.onCollapse();
        } else update(fit(value), true);
      }
      finish();
    };

    // The browser took the pointer away: the drag never happened.
    const onPointerCancel = () => {
      if (dragRef.current) update(start.startWidth);
      finish();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  useEffect(() => () => document.body.classList.remove("sidebar-resizing"), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = clampWidth(width - 16 * direction, bounds);
    else if (event.key === "ArrowRight") next = clampWidth(width + 16 * direction, bounds);
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    else if (event.key === "Enter" || event.key === " ") next = bounds.initial;
    if (next !== undefined) {
      event.preventDefault();
      update(next, true);
    }
  };

  const onDoubleClick = () => update(bounds.initial, true);

  return { width, dragging, separator: { onPointerDown, onKeyDown, onDoubleClick } };
}
