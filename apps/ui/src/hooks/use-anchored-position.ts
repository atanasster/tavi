import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";

import { POPOVER_EDGE_PX, POPOVER_FIT_PX, POPOVER_GAP_PX } from "../lib/layout.js";

/** Where a popover goes beside its anchor, in viewport pixels (`position: fixed`). */
export interface AnchoredPosition {
  readonly left: number;
  readonly top: number;
}

/** How a popover sits by its anchor. */
export interface Anchoring {
  /** The side it prefers; the other is used when it does not fit. */
  readonly placement?: "top" | "bottom";
  /** Centred on the anchor, or its right edge on the anchor's. */
  readonly align?: "center" | "end";
  /** The least room it keeps from the window's left and right edges. */
  readonly edge?: number;
  /** Below the anchor, it is moved up rather than run off the window's foot. */
  readonly clampBelow?: boolean;
}

/** `box`'s place by `anchor` in a `width` × `height` window, `POPOVER_GAP_PX` off the anchor. */
function anchoredPosition(
  anchor: DOMRect,
  box: DOMRect,
  width: number,
  height: number,
  { placement = "top", align = "center", edge = POPOVER_EDGE_PX, clampBelow = false }: Anchoring = {},
): AnchoredPosition {
  const above = anchor.top - box.height - POPOVER_GAP_PX;
  const below = clampBelow
    ? Math.min(anchor.bottom + POPOVER_GAP_PX, height - box.height - POPOVER_GAP_PX)
    : anchor.bottom + POPOVER_GAP_PX;
  const fitsAbove = anchor.top >= box.height + POPOVER_FIT_PX;
  const fitsBelow = anchor.bottom + box.height + POPOVER_FIT_PX <= height;
  const ideal = align === "end" ? anchor.right - box.width : anchor.left + (anchor.width - box.width) / 2;
  return {
    left: Math.max(edge, Math.min(ideal, width - box.width - edge)),
    top: placement === "bottom" ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove ? above : below,
  };
}

/**
 * A popover's place by its anchor while `open`, measured before the browser
 * paints and again when one of `deps` changes. `ready` turns on once it has
 * been placed, and off again as it closes, so it is never seen at 0,0 first.
 */
export function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<Element | null>,
  box: RefObject<Element | null>,
  anchoring: Anchoring = {},
  deps: DependencyList = [],
): { readonly position: AnchoredPosition; readonly ready: boolean } {
  const [position, setPosition] = useState<AnchoredPosition>({ left: 0, top: 0 });
  const [ready, setReady] = useState(false);
  const { placement, align, edge, clampBelow } = anchoring;
  useLayoutEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    if (anchor.current === null || box.current === null) return;
    setPosition(
      anchoredPosition(
        anchor.current.getBoundingClientRect(),
        box.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        anchoring,
      ),
    );
    setReady(true);
    // `anchoring` is a fresh object each render: its fields are what move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, align, edge, clampBelow, ...deps]);
  return { position, ready };
}
