import { useEffect } from "react";

/**
 * Keeps a section nav's current item in sight. On a phone the nav is a strip of tabs that scrolls sideways, and a
 * page opened directly (a link, a reload) would otherwise leave its own tab out of view. Only the strip moves, and
 * only sideways: the page never scrolls, and a desktop column, which does not scroll sideways, never moves.
 */
export function useCurrentNavInView(current: string): void {
  useEffect(() => {
    const item = document.querySelector<HTMLElement>('.center-nav [aria-current="page"]');
    let strip = item?.parentElement ?? null;
    while (strip !== null && strip.scrollWidth <= strip.clientWidth) strip = strip.parentElement;
    if (item === null || strip === null) return;
    const shown = strip.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.left < shown.left) strip.scrollLeft -= shown.left - box.left;
    else if (box.right > shown.right) strip.scrollLeft += box.right - shown.right;
  }, [current]);
}
