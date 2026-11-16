import { hostBlocksThumbnail, type BrowserSensitiveReason } from "@tavi/contracts";
import type { Page } from "playwright";

/**
 * Whether a page may be pictured: one rule for the session card's thumbnail
 * and for the live view's frames, so the two can never disagree about what is sensitive.
 *
 * A page is sensitive, in this order, when:
 *  1. any of its frames is on a host in the no-thumbnail list (`blocked-host`);
 *  2. any frame has a password field (`password-field`);
 *  3. any frame has a payment or one-time-code field — an `autocomplete` of
 *     `cc-number`, `cc-csc`, `cc-exp*` or `one-time-code` (`payment-field`).
 *     A 960-pixel live frame is readable where a 320-pixel thumbnail was not,
 *     so this applies to thumbnails too.
 *
 * A check that fails counts as sensitive (fail closed).
 */

export type SensitiveReason = BrowserSensitiveReason;

/** What the rules need of a page. */
export interface SensitivePage {
  url(): string;
  /** The URL of every frame, the top one included. */
  frameUrls(): readonly string[];
  hasPasswordField(): Promise<boolean>;
  hasPaymentField(): Promise<boolean>;
}

/** Why `page` must not be pictured, or `undefined` when it may be. */
export async function sensitivityOf(page: SensitivePage, blockedHosts: readonly string[]): Promise<SensitiveReason | undefined> {
  let urls: readonly string[];
  try {
    urls = [page.url(), ...page.frameUrls()];
  } catch {
    return "blocked-host";
  }
  if (urls.some((url) => hostBlocksThumbnail(url, blockedHosts))) return "blocked-host";
  if (await page.hasPasswordField().catch(() => true)) return "password-field";
  if (await page.hasPaymentField().catch(() => true)) return "payment-field";
  return undefined;
}

export const PASSWORD_SELECTOR = "input[type=password i]";
/** Card number, security code, expiry (`cc-exp`, `cc-exp-month`, `cc-exp-year`) and one-time codes, as `autocomplete` tokens. */
export const PAYMENT_SELECTOR = ["input", "select"]
  .flatMap((tag) => [
    `${tag}[autocomplete~="cc-number" i]`,
    `${tag}[autocomplete~="cc-csc" i]`,
    `${tag}[autocomplete*="cc-exp" i]`,
    `${tag}[autocomplete~="one-time-code" i]`,
  ])
  .join(", ");

/** Whether any frame of `page` has an element matching `selector`. */
async function anyFrameHas(page: Page, selector: string): Promise<boolean> {
  // Every frame at once: one busy frame does not hold up the others.
  return (await Promise.all(page.frames().map(async (frame) => (await frame.$(selector)) !== null))).some(Boolean);
}

/** A Playwright page as a `SensitivePage`. */
export function playwrightSensitivePage(page: Page): SensitivePage {
  return {
    url: () => page.url(),
    frameUrls: () => page.frames().map((frame) => frame.url()),
    hasPasswordField: () => anyFrameHas(page, PASSWORD_SELECTOR),
    hasPaymentField: () => anyFrameHas(page, PAYMENT_SELECTOR),
  };
}
