import { useEffect } from "react";

/**
 * Keeps a section nav's current item in sight. On a phone the nav is a strip of tabs that scrolls sideways, and a
 * page opened directly (a link, a reload) would otherwise leave its own tab out of view. Only the strip moves, and
 * only sideways: the page never scrolls, and a desktop column, which does not scroll sideways, never moves. It moves
 * again when the tabs change width, as when their counts arrive, but only while the current tab is out of sight.
 */
export function useCurrentNavInView(current: string): void {
  useEffect(() => {
    const item = document.querySelector<HTMLElement>('.center-nav [aria-current="page"]');
    const list = item?.closest("ul") ?? null;
    if (item === null || list === null) return;
    // The strip is the box that scrolls sideways: the list inside it is as wide as its tabs and does not scroll itself.
    const scrolls = (box: HTMLElement) => box.scrollWidth > box.clientWidth && ["auto", "scroll"].includes(getComputedStyle(box).overflowX);
    const bring = () => {
      let strip = item.parentElement;
      while (strip !== null && !scrolls(strip)) strip = strip.parentElement;
      if (strip === null) return;
      const shown = strip.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      if (box.left < shown.left) strip.scrollLeft -= shown.left - box.left;
      else if (box.right > shown.right) strip.scrollLeft += box.right - shown.right;
    };
    bring();
    // A tab's count arrives after the page opens and widens the tabs before it: bring the current one back in view then.
    if (typeof ResizeObserver === "undefined") return;
    // Each tab, not the list: the list's own box keeps its width while what it holds grows past it.
    const watch = new ResizeObserver(bring);
    for (const tab of list.children) watch.observe(tab);
    return () => watch.disconnect();
  }, [current]);
}
