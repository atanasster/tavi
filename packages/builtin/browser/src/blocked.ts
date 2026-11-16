import type { BrowserBlock, BrowserBlockKind } from "@tavi/contracts";

/**
 * Pages that stand between the agent and the page it asked for:
 * a captcha, a bot wall, a rate limit,
 * a cookie-consent wall, a sign-in form. In the Sofia → Tampa run each looked
 * like any other page — Kayak's "What is a bot?", Skyscanner's press-and-hold
 * captcha with no elements at all — and the model read on, or gave up. Named,
 * they can be acted on: handed to the person, or left for another source.
 *
 * Detection reads only what a page shows (its URL, title, the start of its
 * text, its frames) and is deliberately conservative: an article that mentions
 * captchas is not one. Nothing here answers a challenge.
 */

/** What the page showed, sampled in it by `PAGE_SIGNALS_SCRIPT`, plus the navigation's HTTP status. */
export interface PageSignals {
  readonly url: string;
  readonly title?: string | undefined;
  /** The start of the body's text. */
  readonly text: string;
  /** The `src` of every frame on the page. */
  readonly frames: readonly string[];
  /** A visible password field. */
  readonly password: boolean;
  readonly status?: number | undefined;
}

/** The most body text sampled: the challenge pages that matter say what they are at the top. */
const SIGNAL_TEXT_CHARS = 3_000;

/** Sampled in the page: a string, since this package has no DOM types. */
export const PAGE_SIGNALS_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? (body.innerText || "").slice(0, ${SIGNAL_TEXT_CHARS}) : "";
  const frames = [...document.querySelectorAll("iframe")].map((frame) => frame.src || "").filter((src) => src !== "").slice(0, 20);
  const password = [...document.querySelectorAll('input[type="password"]')].some((input) => { const box = input.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  return { text, frames, password };
})()`;

/** A page this short is all challenge: a long one that mentions "verify you are human" is an article. */
const SHORT_PAGE_CHARS = 1_200;

const CHALLENGE_FRAMES =
  /(?:google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com)/i;

/** A host that is only for signing in (`accounts.google.com`, `login.microsoftonline.com`). */
const SIGN_IN_PLACE = /^(login|logon|signin|auth|sso|accounts?)\./i;
/** A path segment that names a sign-in (`/login`, `/users/sign_in`), not an account's settings. */
const SIGN_IN_SEGMENT = /^(log-?in|log_in|logon|sign-?in|sign_in|signin|authenticate|auth)$/;

interface Rule {
  readonly kind: BrowserBlockKind;
  readonly detail: string;
  readonly matches: (signals: PageSignals, url: URL | undefined, text: string) => boolean;
}

const pathOf = (url: URL | undefined): string => (url === undefined ? "" : `${url.hostname}${url.pathname}`.toLowerCase());

const RULES: readonly Rule[] = [
  {
    kind: "rate-limit",
    detail: "Google's unusual-traffic page",
    matches: (_signals, url) => /(^|\.)google\.[a-z.]+\/sorry\//.test(pathOf(url)),
  },
  {
    kind: "consent",
    detail: "a cookie-consent page",
    matches: (_signals, url) => /^consent\.(google|youtube)\.[a-z.]+$/.test(url?.hostname ?? ""),
  },
  {
    kind: "captcha",
    detail: "a press-and-hold human check (PerimeterX)",
    matches: (_signals, url, text) =>
      /\/px\/captcha|captcha-v2/.test(pathOf(url)) || (text.length < SHORT_PAGE_CHARS && /press\s*(&|and)\s*hold/.test(text)),
  },
  {
    kind: "bot-wall",
    detail: "the site's page for automated visitors",
    matches: (_signals, url) => /kayak\.[a-z.]+\/help\/bots/.test(pathOf(url)),
  },
  {
    kind: "captcha",
    detail: "Cloudflare's browser check",
    matches: (signals, url, text) =>
      /\/cdn-cgi\/challenge-platform/.test(pathOf(url)) ||
      /^just a moment/i.test(signals.title ?? "") ||
      (text.length < SHORT_PAGE_CHARS && /checking (if the site connection is secure|your browser)/.test(text)),
  },
  {
    kind: "captcha",
    detail: "a captcha",
    matches: (signals, _url, text) => signals.frames.some((src) => CHALLENGE_FRAMES.test(src)) && text.length < SHORT_PAGE_CHARS,
  },
  { kind: "rate-limit", detail: "HTTP 429: too many requests", matches: (signals) => signals.status === 429 },
  {
    kind: "rate-limit",
    detail: "a virtual waiting room",
    matches: (signals, url, text) =>
      /(^|\.)queue-it\.net$/.test(url?.hostname ?? "") ||
      /queue-it/i.test(signals.title ?? "") ||
      (text.length < SHORT_PAGE_CHARS &&
        /(you are now in line|virtual waiting room|in the waiting room|your estimated wait time|queue-it|please wait while we (redirect|place) you in (the )?queue)/.test(
          text,
        )),
  },
  {
    kind: "rate-limit",
    detail: "a rate-limit page",
    // A page that says it limited this client, or one that mentions a rate limit and came back with an error status:
    // a short page of API docs that explains rate limits is no wall.
    matches: (signals, _url, text) =>
      text.length < SHORT_PAGE_CHARS &&
      (/(too many requests|you('ve| have) made too many requests|temporarily rate[- ]limited|rate limit exceeded|you('ve| have) been rate[- ]limited)/.test(
        text,
      ) ||
        (signals.status !== undefined &&
          (signals.status < 200 || signals.status >= 300) &&
          /(rate limit(ed)?|please try again in a few (minutes|moments|seconds))/.test(text))),
  },
  {
    kind: "bot-wall",
    detail: "a page asking whether this is a robot",
    matches: (_signals, _url, text) =>
      text.length < SHORT_PAGE_CHARS &&
      /(are you a (robot|human)|verify (that )?you are (a )?human|unusual traffic|automated (access|queries|requests)|access (to this page )?(has been )?denied|bot detected)/.test(
        text,
      ),
  },
  {
    kind: "bot-wall",
    detail: "HTTP 403: access denied",
    matches: (signals, _url, text) => signals.status === 403 && text.length < SHORT_PAGE_CHARS,
  },
  {
    kind: "login",
    detail: "a sign-in page",
    matches: (signals, url) =>
      signals.password &&
      (SIGN_IN_PLACE.test(url?.hostname ?? "") ||
        (url?.pathname ?? "")
          .toLowerCase()
          .split("/")
          .some((segment) => SIGN_IN_SEGMENT.test(segment))),
  },
];

/** The first block `signals` show, or `undefined` for a page that is just a page. */
export function classifyPage(signals: PageSignals): BrowserBlock | undefined {
  let url: URL | undefined;
  try {
    url = new URL(signals.url);
  } catch {
    url = undefined;
  }
  const text = signals.text.replace(/\s+/g, " ").trim().toLowerCase();
  const rule = RULES.find((candidate) => candidate.matches(signals, url, text));
  return rule === undefined ? undefined : { kind: rule.kind, detail: rule.detail };
}

/**
 * Finds and clicks the most privacy-preserving answer on a cookie-consent
 * banner — reject or decline every non-essential cookie — and answers the
 * button's text, or `null` when there is none. A banner that offers only
 * "accept" is left alone: accepting is the person's choice, not the agent's.
 * Run in the page: a string, since this package has no DOM types.
 */
export const DECLINE_CONSENT_SCRIPT = `(() => {
  const ids = ["#onetrust-reject-all-handler", "#didomi-notice-disagree-button", "#CybotCookiebotDialogBodyButtonDecline", ".qc-cmp2-summary-buttons button[mode=secondary]", "#truste-consent-required", ".fc-cta-do-not-consent"];
  const shown = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  for (const selector of ids) {
    const element = document.querySelector(selector);
    if (element && shown(element)) { element.click(); return (element.innerText || element.value || selector).trim().slice(0, 80); }
  }
  const words = /^(reject all|reject|decline all|decline|refuse all|deny all|only necessary|necessary only|use necessary cookies only|only essential|essential only|continue without accepting|alle ablehnen|ablehnen|nur notwendige|tout refuser|refuser|rechazar todo|rechazar|rifiuta tutto|rifiuta|alles weigeren|weigeren|отхвърляне на всички|отказ)$/i;
  // Only inside a consent banner: a "Decline" elsewhere (an invitation, a payment) is not the agent's to press.
  const banner = /cookie|consent|privacy|datenschutz|confidentialit|бисквитк/i;
  // A dialog counts only when it speaks of cookies: an OAuth, invitation or terms dialog may say "privacy" and offer "Deny".
  const cookieWords = /cookie|бисквитк/i;
  const containers = /^consent\\./.test(location.hostname)
    ? [document.body]
    : [
        ...[...document.querySelectorAll('[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i], [aria-label*=consent i]')]
          .filter((element) => banner.test((element.innerText || "") + " " + (element.id || "") + " " + String(element.className || ""))),
        ...[...document.querySelectorAll("[role=dialog], [role=alertdialog]")].filter((element) => cookieWords.test(element.innerText || "")),
      ].filter((element) => shown(element) && element !== document.body && (element.innerText || "").length < 4000);
  const buttons = containers.flatMap((container) => [...container.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]).filter(shown);
  const label = (element) => ((element.innerText || element.value || element.getAttribute("aria-label") || "") + "").replace(/\\s+/g, " ").trim();
  const match = buttons.find((element) => words.test(label(element)));
  if (!match) {
    // No way to decline: a banner that covers most of the page (or is modal) stands in the way; a strip at an edge does not.
    const covering = containers.some((container) => {
      const box = container.getBoundingClientRect();
      return container.getAttribute("aria-modal") === "true" || box.width * box.height >= 0.4 * window.innerWidth * window.innerHeight;
    });
    return covering && buttons.length > 0 ? { wall: true } : null;
  }
  match.click();
  return { pressed: label(match).slice(0, 80) };
})()`;
