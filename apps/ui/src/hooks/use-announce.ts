import { useEffect } from "react";

/** The id of the page's one announcement region, which `index.html` holds. */
export const ANNOUNCER_ID = "announcer";

/** What has been said in this task so far: a second sentence joins the first rather than replacing it. */
let thisTask: string[] | undefined;

/**
 * Put `text` in the page's live region. Two things said in one go (a note,
 * and the page's own status in the same commit) are said together, neither
 * talking over the other; the same sentence said again is cleared first and
 * written on the next frame, so it is read again rather than taken as no change.
 */
export function say(text: string): void {
  if (typeof document === "undefined" || text === "") return;
  const region = document.getElementById(ANNOUNCER_ID);
  if (region === null) return;
  if (thisTask !== undefined) {
    if (!thisTask.includes(text)) thisTask.push(text);
    region.textContent = thisTask.join(" ");
    return;
  }
  thisTask = [text];
  queueMicrotask(() => {
    thisTask = undefined;
  });
  if (region.textContent !== text) {
    region.textContent = text;
    return;
  }
  region.textContent = "";
  const again = (): void => {
    if (region.textContent === "") region.textContent = text;
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(again);
  else setTimeout(again, 0);
}

/**
 * Say `text` through the page's one live region when it changes to something.
 *
 * A note that mounts together with its own `role="status"` is often not read:
 * a live region inserted with its first message is commonly missed. The
 * region in `index.html` is in the accessibility tree from the start, so a
 * note said through it is heard; the note itself is drawn as a plain line.
 */
export function useAnnounce(text: string | undefined): void {
  useEffect(() => {
    if (text !== undefined) say(text);
  }, [text]);
}
