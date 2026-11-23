import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The example UI plugin (`examples/ui-plugins/minimal-browser-view`) speaks
 * the canvas's language: `live.js` run against a stand-in page, told its
 * language and words in `init`, then again in a `locale` message, as the host
 * sends them. Its packs are the words it is handed.
 */

const folder = join(import.meta.dirname, "..", "examples", "ui-plugins", "minimal-browser-view");
const script = readFileSync(join(folder, "live.js"), "utf8");
const pack = (locale: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(folder, "locales", `${locale}.json`), "utf8")) as { messages: Record<string, string> }).messages;

interface Page {
  readonly status: { textContent: string };
  readonly frame: { alt: string; hidden: boolean; src: string };
  readonly root: { lang: string };
  readonly title: () => string;
  readonly hear: (message: Record<string, unknown>) => void;
  readonly sent: Record<string, unknown>[];
}

function page(): Page {
  const status = { textContent: "Waiting for the agent's browser…" };
  const frame = { alt: "The agent's page", hidden: true, src: "" };
  const root = { lang: "en", dataset: {}, style: { setProperty: () => undefined, colorScheme: "" } };
  const document = {
    title: "Browser (minimal)",
    documentElement: root,
    body: { dataset: {} as Record<string, string> },
    querySelector: (selector: string) => (selector === "[data-status]" ? status : frame),
  };
  const sent: Record<string, unknown>[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
  let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
  const window = {
    addEventListener: (_type: string, handler: typeof listener) => {
      listener = handler;
    },
  };
  runInNewContext(script, { document, window, parent, Image: class {} });
  return {
    status,
    frame,
    root,
    title: () => document.title,
    hear: (message) => listener?.({ source: parent, data: { abi: "tavi.ui/1", ...message } }),
    sent,
  };
}

describe("the minimal browser view's language", () => {
  it("ships a Bulgarian pack with every English message", () => {
    expect(Object.keys(pack("bg")).sort()).toEqual(Object.keys(pack("en")).sort());
  });

  it("says its words in the language init names, and again when the language changes", () => {
    const view = page();
    view.hear({ type: "init", locale: "bg", messages: pack("bg"), context: {} });
    expect(view.root.lang).toBe("bg");
    expect(view.title()).toBe(pack("bg")["view.title"]);
    expect(view.frame.alt).toBe(pack("bg")["frame.alt"]);
    expect(view.status.textContent).toBe(pack("bg")["status.waiting"]);
    view.hear({ type: "channel", channel: "browser.live", seq: 1, message: { kind: "ended", sessionId: "s1" } });
    expect(view.status.textContent).toBe(pack("bg")["status.ended"]);
    view.hear({ type: "locale", locale: "en", messages: pack("en") });
    expect(view.root.lang).toBe("en");
    expect(view.status.textContent).toBe("The browser session ended.");
  });

  it("keeps an address as it is, and speaks English to a host that sends no language", () => {
    const view = page();
    view.hear({ type: "init", context: {} });
    expect(view.root.lang).toBe("en");
    expect(view.status.textContent).toBe("Waiting for the agent's browser…");
    view.hear({
      type: "channel",
      channel: "browser.live",
      seq: 1,
      message: { kind: "navigated", sessionId: "s1", url: "https://example.com/" },
    });
    view.hear({ type: "locale", locale: "bg", messages: pack("bg") });
    expect(view.status.textContent).toBe("https://example.com/");
    expect(view.sent.map((message) => message["type"])).toEqual(["ready", "watch"]);
  });
});
