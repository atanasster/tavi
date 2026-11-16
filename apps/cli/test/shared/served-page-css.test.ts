import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApprovalLinkHandler } from "../../src/features/approvals/links.js";
import { oauthCallbackPage } from "../../src/features/oauth/flow.js";
import {
  SERVED_PAGE_CSS,
  SERVED_PAGE_DARK_TOKENS,
  SERVED_PAGE_LIGHT_TOKENS,
  SERVED_PAGE_STYLE,
  SERVED_PAGE_STYLE_SRC,
} from "../../src/shared/served-page-css.js";

/** The canvas's tokens: the first `:root` block's declarations, and the dark-scheme one's. */
function canvasTokens(): { readonly light: ReadonlyMap<string, string>; readonly dark: ReadonlyMap<string, string> } {
  const css = readFileSync(join(import.meta.dirname, "../../../ui/src/styles/tokens.css"), "utf8");
  const declarations = (block: string): Map<string, string> =>
    new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? "", (match[2] ?? "").trim()]));
  const light = /^:root\s*\{([^}]*)\}/m.exec(css)?.[1];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (light === undefined || dark === undefined) throw new Error("no light or dark :root block");
  return { light: declarations(light), dark: declarations(dark) };
}

describe("the served pages' stylesheet", () => {
  const canvas = canvasTokens();

  it("has the canvas's values, light and dark", () => {
    for (const [token, value] of Object.entries(SERVED_PAGE_LIGHT_TOKENS)) expect(value, `${token} (light)`).toBe(canvas.light.get(token));
    for (const [token, value] of Object.entries(SERVED_PAGE_DARK_TOKENS)) expect(value, `${token} (dark)`).toBe(canvas.dark.get(token));
  });

  it("gives every colour a dark value", () => {
    const colours = Object.keys(SERVED_PAGE_LIGHT_TOKENS).filter((token) => /^\d+ \d+% \d+%$/.test(SERVED_PAGE_LIGHT_TOKENS[token] ?? ""));
    expect(colours.length).toBeGreaterThan(5);
    expect(colours.filter((token) => SERVED_PAGE_DARK_TOKENS[token] === undefined)).toEqual([]);
    expect(Object.keys(SERVED_PAGE_DARK_TOKENS).every((token) => colours.includes(token))).toBe(true);
  });

  it("follows the reader's scheme and names no colour, size or font of its own", () => {
    expect(SERVED_PAGE_CSS).toContain("color-scheme:light dark");
    expect(SERVED_PAGE_CSS).toContain("@media (prefers-color-scheme: dark)");
    const rules = SERVED_PAGE_CSS.replace(/:root\{[^}]*\}/g, "").replace("@media (prefers-color-scheme: dark){}", "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
    expect(rules).not.toMatch(/\d(px|rem|em)\b/);
    expect(rules).not.toMatch(/system-ui|monospace/);
  });

  it("is allowed by its hash, the one inline style either page carries", async () => {
    // The hash of the bytes the pages actually serve, read back out of their HTML.
    const served = (html: string): string =>
      `'sha256-${createHash("sha256")
        .update(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "")
        .digest("base64")}'`;
    expect(SERVED_PAGE_STYLE_SRC).toBe(`'sha256-${createHash("sha256").update(SERVED_PAGE_CSS).digest("base64")}'`);
    const oauth = oauthCallbackPage({ ok: true, message: "Done." });
    expect(oauth.body).toContain(SERVED_PAGE_STYLE);
    expect(oauth.body).not.toContain("style=");
    expect(oauth.headers["content-security-policy"]).toBe(`default-src 'none'; style-src ${served(oauth.body)}`);

    const headers = new Map<string, string>();
    let html = "";
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: (body: string) => {
        html = body;
      },
    };
    const links = createApprovalLinkHandler({
      describeLink: () => Promise.resolve({ ok: false, message: "gone" }),
      useLink: () => Promise.resolve({ ok: false, message: "gone" }),
    } as unknown as Parameters<typeof createApprovalLinkHandler>[0]);
    await links({ method: "GET", url: "/i/unknown-token-00000" } as never, res as never);
    expect(html).toContain(SERVED_PAGE_STYLE);
    expect(html).not.toContain("style=");
    expect(headers.get("content-security-policy")).toContain(`style-src ${served(html)};`);
    expect(headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });
});
