import { useEffect, type RefObject } from "react";

import { ANNOUNCER_ID } from "./use-announce.js";

/**
 * How many open modals hold each element inert. Counted, so a modal opened
 * over another (a takeover over the expanded browser view) and closed again
 * leaves the page as the one beneath it needs.
 */
const holds = new WeakMap<Element, number>();

function hold(element: Element): boolean {
  const count = holds.get(element);
  if (count === undefined) {
    // Inert by someone else's hand: not ours to count, or to undo.
    if (element.hasAttribute("inert")) return false;
    element.setAttribute("inert", "");
  }
  holds.set(element, (count ?? 0) + 1);
  return true;
}

function release(element: Element): void {
  const count = holds.get(element) ?? 0;
  if (count <= 1) {
    holds.delete(element);
    element.removeAttribute("inert");
  } else holds.set(element, count - 1);
}

/**
 * What stays live beside a modal: the page's live region (so it is still
 * heard), and a backdrop that closes the modal on a press (marked
 * `data-modal-backdrop`).
 */
const spared = (element: Element): boolean =>
  element.id === ANNOUNCER_ID || element.tagName === "SCRIPT" || element.hasAttribute("data-modal-backdrop");

/** A modal mounted over this one (or what holds it) is not put behind it: it makes its own page inert. */
const holdsModal = (element: Element): boolean =>
  element.matches('[aria-modal="true"]') || element.querySelector('[aria-modal="true"]') !== null;

/**
 * While `active`, `ref`'s element is modal without being a native `<dialog>`:
 * everything else on the page is made `inert` (out of the Tab order and the
 * accessibility tree), including what mounts beside it while it is open; focus
 * moves into it unless it is there already, and on the way out focus goes
 * back to what had it before.
 */
export function useModalFocus(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || element === null) return undefined;
    const opener =
      document.activeElement instanceof HTMLElement && !element.contains(document.activeElement) ? document.activeElement : undefined;
    const made: Element[] = [];
    const inert = (sibling: Element): void => {
      if (!spared(sibling) && hold(sibling)) made.push(sibling);
    };
    const path: Element[] = [];
    for (let node: Element = element; node.parentElement !== null && node !== document.body; node = node.parentElement) {
      path.push(node);
      for (const sibling of node.parentElement.children) if (sibling !== node) inert(sibling);
    }
    // A toast, a link or an overlay mounted while it is open is behind it too.
    const added = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && !path.includes(node) && node.isConnected && !holdsModal(node)) inert(node);
    });
    for (const node of path) if (node.parentElement !== null) added.observe(node.parentElement, { childList: true });
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    return () => {
      added.disconnect();
      for (const sibling of made) release(sibling);
      if (opener?.isConnected === true) opener.focus({ preventScroll: true });
    };
  }, [active, ref]);
}
