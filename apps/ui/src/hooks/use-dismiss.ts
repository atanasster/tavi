import { useEffect, useRef, type RefObject } from "react";

/** What closed a popover: the person's Escape, a press outside it, or the page moving under it. */
export type DismissedBy = "escape" | "outside" | "scroll" | "resize";

/**
 * A popover's ways out while `open`: Escape, a press outside every element in
 * `inside` (none: presses never close it), and — with `scroll` and `resize` —
 * the page moving under it (a scroll inside `inside` does not). With
 * `capture` it hears these before the page does.
 *
 * An Escape it takes is marked handled (`preventDefault`), so the page's own
 * Escape (stopping the running turn) skips it, while a panel around the
 * popover still hears the key. `claimEscape` says, per press, whether to mark
 * it: a tooltip that came with keyboard focus lets the key go on unclaimed.
 * `keysWithin` takes only an Escape pressed inside those elements (a popover
 * that sits in the page, beside its chip), leaving every other one to the page.
 */
export function useDismiss(
  open: boolean,
  dismiss: (by: DismissedBy) => void,
  {
    inside = [],
    capture = false,
    scroll = false,
    resize = false,
    claimEscape,
    keysWithin,
  }: {
    readonly inside?: readonly RefObject<Element | null>[];
    readonly capture?: boolean;
    readonly scroll?: boolean;
    readonly resize?: boolean;
    readonly claimEscape?: () => boolean;
    readonly keysWithin?: readonly RefObject<Element | null>[];
  } = {},
): void {
  const latest = useRef({ dismiss, inside, claimEscape, keysWithin });
  latest.current = { dismiss, inside, claimEscape, keysWithin };
  useEffect(() => {
    if (!open) return undefined;
    const within = (target: EventTarget | null): boolean =>
      latest.current.inside.some((ref) => ref.current?.contains(target as Node | null) === true);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      const keys = latest.current.keysWithin;
      if (keys !== undefined && !keys.some((ref) => ref.current?.contains(event.target as Node | null) === true)) return;
      if (latest.current.claimEscape?.() ?? true) event.preventDefault();
      latest.current.dismiss("escape");
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!within(event.target)) latest.current.dismiss("outside");
    };
    const onScroll = (event: Event): void => {
      if (!within(event.target)) latest.current.dismiss("scroll");
    };
    const onResize = (): void => latest.current.dismiss("resize");
    const presses = latest.current.inside.length > 0;
    document.addEventListener("keydown", onKeyDown, capture);
    if (presses) document.addEventListener("pointerdown", onPointerDown, capture);
    if (scroll) document.addEventListener("scroll", onScroll, true);
    if (resize) window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown, capture);
      if (presses) document.removeEventListener("pointerdown", onPointerDown, capture);
      if (scroll) document.removeEventListener("scroll", onScroll, true);
      if (resize) window.removeEventListener("resize", onResize);
    };
  }, [open, capture, scroll, resize]);
}
