import { useEffect, useRef, type DependencyList, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useAnchoredPosition, type Anchoring } from "../hooks/use-anchored-position.js";
import { useDismiss, type DismissedBy } from "../hooks/use-dismiss.js";

/** What closed a popover: one of `useDismiss`'s ways out, or Tab past its edge (an anchored one). */
export type PopoverClosedBy = DismissedBy | "tab";

/** What Tab reaches on the page, in its order. */
const TAB_STOPS =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A non-modal popover (`role="dialog"`), shown while it is mounted: its
 * opener renders it when open and closes it in `onClose`.
 *
 * Escape closes it — marked handled, so the page's own Escape (stopping the
 * running turn) skips it. Where focus goes as it closes is the opener's: it
 * hears how it closed.
 *
 * Without `anchor` it sits where it is in the page, placed by its own CSS,
 * and takes an Escape pressed inside its parent (it and its toggle) only.
 * With `anchor` (its toggle) it is portaled to the page's end and placed
 * beside it (`position: fixed`; `data-ready` once placed, so it is never
 * seen at 0,0), and so it hears Escape before the page does, closes on a
 * press outside it and its anchor and as the page moves under it, and Tab
 * past either of its edges closes it and goes on beside its anchor, as if it
 * sat there.
 *
 * `initialFocus` is a selector inside it that takes focus once it is shown
 * (and placed): none, and focus stays where it was.
 */
export function Popover({
  as: Element = "div",
  label,
  labelledBy,
  id,
  className,
  anchor,
  anchoring,
  deps = [],
  initialFocus,
  onClose,
  children,
}: {
  readonly as?: "div" | "section";
  readonly label?: string;
  readonly labelledBy?: string;
  readonly id?: string;
  readonly className: string;
  readonly anchor?: RefObject<HTMLElement | null>;
  readonly anchoring?: Anchoring;
  /** What moves it by its anchor when it changes (what it shows, so its size). */
  readonly deps?: DependencyList;
  readonly initialFocus?: string;
  readonly onClose: (by: PopoverClosedBy) => void;
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const none = useRef<HTMLElement>(null);
  const anchored = anchor !== undefined;
  const { position, ready: placed } = useAnchoredPosition(anchored, anchor ?? none, box, anchoring, deps);
  const ready = !anchored || placed;
  // In place it sits beside its toggle in one wrap: an Escape pressed there is its, any other the page's.
  const wrap = useRef<Element | null>(null);
  useEffect(() => {
    wrap.current = box.current?.parentElement ?? null;
  });
  useDismiss(true, onClose, anchored ? { inside: [box, anchor], capture: true, scroll: true, resize: true } : { keysWithin: [wrap] });
  useEffect(() => {
    if (ready && initialFocus !== undefined)
      box.current?.querySelector<HTMLElement>(initialFocus)?.focus(anchored ? { preventScroll: true } : undefined);
    // Once, as it is first shown: a later move by its anchor does not take focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** Tab out of an anchored popover (it is at the page's end) goes on beside its anchor, and closes it. */
  const leaveByTab = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab" || anchor === undefined) return;
    const inside = [...(box.current?.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])") ?? [])];
    const edge = event.shiftKey ? inside[0] : inside.at(-1);
    if (document.activeElement !== edge) return;
    event.preventDefault();
    onClose("tab");
    const toggle = anchor.current;
    if (toggle === null) return;
    if (event.shiftKey) {
      toggle.focus();
      return;
    }
    const stops = [...document.querySelectorAll<HTMLElement>(TAB_STOPS)]
      // Only what Tab itself would reach: not inside the popover, an inert or hidden part, or something not drawn.
      .filter(
        (element) =>
          !box.current?.contains(element) &&
          element.closest("[inert], [hidden], [aria-hidden='true']") === null &&
          (typeof element.checkVisibility !== "function" || element.checkVisibility({ visibilityProperty: true })),
      );
    (stops[stops.indexOf(toggle) + 1] ?? toggle).focus();
  };

  const popover = (
    <Element
      ref={box as RefObject<HTMLDivElement>}
      id={id}
      className={className}
      role="dialog"
      aria-label={label}
      aria-labelledby={labelledBy}
      {...(anchored
        ? {
            style: { left: `${position.left}px`, top: `${position.top}px` },
            "data-ready": placed ? "" : undefined,
            onKeyDown: leaveByTab,
          }
        : {})}
    >
      {children}
    </Element>
  );
  return anchored ? createPortal(popover, document.body) : popover;
}
