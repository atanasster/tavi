import type { CDPSession, Frame, Page } from "playwright";

/**
 * Which form fields hold a secret: one
 * rule for what an observation never lists the value of, what a
 * change summary never says, and what a screenshot for the model never shows.
 * A password field, and any field whose `autocomplete`, name, id, label or
 * placeholder names a password (one a "show password" switch made plain), a
 * one-time code, a PIN, a card's number, code or expiry, an IBAN or an SSN.
 */
export const SECRET_FIELD_PATTERN =
  "otp|one.?time|passcode|password|passwd|pin\\b|cvc|cvv|csc|card.?num|cc-?(number|num|csc|exp)|\\bcc-[a-z-]+|security.?code|iban|ssn";

/**
 * Run in the page: whether a shown field that holds a secret has a value in it.
 * A string, since this package has no DOM types.
 */
const SECRET_VALUE_SCRIPT = `(() => {
  const secret = new RegExp(${JSON.stringify(SECRET_FIELD_PATTERN)}, "i");
  const shown = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const roots = [document];
  for (const host of document.querySelectorAll("*")) if (host.shadowRoot) roots.push(host.shadowRoot);
  for (const root of roots) {
    for (const field of root.querySelectorAll("input, textarea")) {
      if (!shown(field) || (field.value || "") === "") continue;
      const type = (field.type || "").toLowerCase();
      const label = field.labels && field.labels[0] ? field.labels[0].innerText || "" : "";
      const naming = [field.getAttribute("autocomplete"), field.getAttribute("name"), field.id, field.getAttribute("aria-label"), field.getAttribute("placeholder"), label].join(" ");
      if (type === "password" || secret.test(naming)) return true;
    }
  }
  return false;
})()`;

const framesIn = <T extends { readonly childFrames?: readonly T[] | undefined }>(node: T): T[] => [
  node,
  ...(node.childFrames ?? []).flatMap((child) => framesIn(child)),
];

/** Whether any frame a CDP session reaches shows a secret with a value; a frame it cannot read answers `"unknown"`. */
async function sessionSecretValue(cdp: CDPSession): Promise<boolean | "unknown"> {
  const tree = await cdp.send("Page.getFrameTree");
  const answers = await Promise.all(
    framesIn(tree.frameTree).map(async (node) => {
      const world = await cdp.send("Page.createIsolatedWorld", { frameId: node.frame.id, worldName: "tavi-secret-check" });
      const answer = await cdp.send("Runtime.evaluate", {
        expression: SECRET_VALUE_SCRIPT,
        contextId: world.executionContextId,
        returnByValue: true,
      });
      return typeof answer.result.value === "boolean" ? answer.result.value : "unknown";
    }),
  );
  return answers.includes(true) ? true : answers.includes("unknown") ? "unknown" : false;
}

/** Playwright's answer when a frame runs in its page's process: it is read through the page's own session. */
const IN_PROCESS_FRAME = /does not have a separate CDP session/i;

/**
 * Evaluates `SECRET_VALUE_SCRIPT` in the browser's CDP isolated world, so page
 * scripts cannot tamper with it, in every frame: the page's own process and
 * each out-of-process frame's (a payment widget's card field). A frame that
 * cannot be read answers `"unknown"`, which the caller refuses.
 */
export async function isolatedSecretValue(page: Page): Promise<boolean | "unknown"> {
  const context = typeof page.context === "function" ? page.context() : undefined;
  if (context === undefined || typeof context.newCDPSession !== "function") {
    if (typeof page.evaluate === "function") {
      const value = await page.evaluate(SECRET_VALUE_SCRIPT);
      return typeof value === "boolean" ? value : "unknown";
    }
    return "unknown";
  }
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
  const targets: (Page | Frame)[] = [page, ...(typeof page.frames === "function" ? page.frames() : []).filter((frame) => frame !== main)];
  const answers = await Promise.all(
    targets.map(async (target): Promise<boolean | "unknown"> => {
      let cdp: CDPSession;
      try {
        cdp = await context.newCDPSession(target);
      } catch (error) {
        // An in-process frame is in the page's tree, read with the page; any other failure leaves a frame unread.
        return target !== page && error instanceof Error && IN_PROCESS_FRAME.test(error.message) ? false : "unknown";
      }
      try {
        return await sessionSecretValue(cdp);
      } catch {
        return "unknown";
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }),
  );
  return answers.includes(true) ? true : answers.includes("unknown") ? "unknown" : false;
}
