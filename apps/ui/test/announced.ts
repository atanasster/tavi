import { ANNOUNCER_ID } from "../src/hooks/use-announce.js";

/** The page's live region, stood up as `index.html` holds it, and emptied for the next test. */
export function freshAnnouncer(): HTMLElement {
  const region = document.getElementById(ANNOUNCER_ID) ?? document.createElement("p");
  if (region.id !== ANNOUNCER_ID) {
    region.id = ANNOUNCER_ID;
    region.className = "visually-hidden";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.prepend(region);
  }
  region.textContent = "";
  return region;
}

/** What the page said last through its live region. */
export const announced = (): string => document.getElementById(ANNOUNCER_ID)?.textContent ?? "";
