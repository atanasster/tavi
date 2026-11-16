import { htmlToText, labelledResult } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { WEB_FETCH_PAGE_BYTES, fetchRequestOf, labelledFetch, pageOfFetch, rawFetch, readableFetch } from "../src/fetch-tool.js";

describe("htmlToText", () => {
  it("keeps a page's words, blocks and links, never its scripts, styles or chrome", () => {
    const html = `<!doctype html><html><head><title>T</title><style>p{}</style></head><body>
      <nav><a href="/">Home</a></nav>
      <main><h1>Fares &amp; times</h1><p>SOF &rarr; TPA from <b>898&nbsp;EUR</b>.</p>
      <ul><li>Lufthansa</li><li>Turkish</li></ul>
      <table><tr><td>Mon</td><td>898</td></tr></table>
      <p><a href="/book/1?x=1&amp;y=2">Book it</a> or <a href="javascript:alert(1)">this</a>.</p>
      <script>var secret = 1;</script></main><footer>Copyright</footer></body></html>`;
    const text = htmlToText(html, "https://flights.example/r");
    expect(text).toBe(
      "Fares & times\nSOF → TPA from 898 EUR.\n- Lufthansa\n- Turkish\nMon | 898 |\nBook it (https://flights.example/book/1?x=1&y=2) or this.",
    );
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Home");
  });

  it("decodes numeric entities and reads a page without main content whole", () => {
    expect(htmlToText("<p>&#8364;10 &#x2014; ok</p><div>more</div>")).toBe("€10 — ok\nmore");
  });

  it("reads a page that marks no main content whole, a form-wrapped page included, and keeps a broken entity as written", () => {
    expect(
      htmlToText(
        "<form id=aspnet><h1>Permit</h1><p>Apply by\n  Friday</p></form><nav><a href='/p/2'>Next page</a></nav>",
        "https://gov.example/",
      ),
    ).toBe("Permit\nApply by Friday\nNext page (https://gov.example/p/2)");
    expect(htmlToText("<p>&#99999999; &rsquo;ok&rsquo; &bogus;</p>")).toBe("&#99999999; ’ok’ &bogus;");
  });

  it("stays fast on a page of unclosed tags and comments", () => {
    const started = Date.now();
    for (const page of [
      "<".repeat(16_000),
      "<article>x".repeat(16_000),
      "<a href=x>y".repeat(16_000),
      "<!--".repeat(16_000),
      "<script>".repeat(16_000),
    ])
      htmlToText(page.repeat(32));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives the model a fetched HTML page as text, and anything else as it came", () => {
    const html = {
      provider: "p",
      receipt: {} as never,
      content: {
        url: "https://a.example/",
        statusCode: 200,
        truncated: false,
        body: { kind: "html" as const, content: "<p>Hi <a href='/x'>there</a></p>" },
      },
    };
    expect(readableFetch(html)).toMatchObject({
      content: { body: { kind: "text", content: "Hi there (https://a.example/x)" } },
      readable: "the page's HTML as its text and links",
    });
    const markdown = { ...html, content: { ...html.content, body: { kind: "text" as const, content: "# Hi" } } };
    expect(readableFetch(markdown)).toBe(markdown);
  });

  it("hands a raw fetch back as it came, for the text types the transport reads, and refuses any other", () => {
    const fetched = (contentType: string) => ({
      provider: "p",
      receipt: { contentType } as never,
      content: {
        url: "https://a.example/",
        statusCode: 200,
        truncated: false,
        body: { kind: "html" as const, content: "<p>Hi</p>" },
      },
    });
    for (const type of ["text/html", "application/xml", "text/xml", "application/json", "text/plain", "text/markdown"]) {
      const input = fetched(type);
      expect(rawFetch(input)).toBe(input);
    }
    expect(() => rawFetch(fetched("application/octet-stream"))).toThrow(/does not return content-type application\/octet-stream raw/);
  });

  it("labels a fetch with the host it ended on after a redirect, not the one asked for", () => {
    const redirected = {
      provider: "p",
      receipt: {} as never,
      content: { url: "https://evil.example/landing", statusCode: 200, truncated: false, body: { kind: "text" as const, content: "hi" } },
    };
    expect(labelledResult(labelledFetch(redirected))).toMatchObject({ output: redirected, label: { host: "evil.example" } });
  });

  it("returns a long page's text a page at a time, saying where the next starts, and a short one whole", () => {
    const fetched = {
      provider: "p",
      receipt: {} as never,
      content: { url: "https://a.example/long", statusCode: 200, truncated: false, body: { kind: "text" as const, content: "abcdefghij" } },
    };
    expect(pageOfFetch(fetched, 0, 4)).toMatchObject({
      content: { body: { content: "abcd" } },
      page: { offset: 0, totalChars: 10, nextOffset: 4 },
    });
    const last = pageOfFetch(fetched, 8, 4);
    expect(last).toMatchObject({ content: { body: { content: "ij" } }, page: { offset: 8, totalChars: 10 } });
    expect(last.page).not.toHaveProperty("nextOffset");
    expect(pageOfFetch(fetched, 0, 10)).toBe(fetched);
  });

  it("holds a page of non-Latin text to its byte budget, and never splits a character in two", () => {
    const page = (content: string) => ({
      provider: "p",
      receipt: {} as never,
      content: { url: "https://a.example/long", statusCode: 200, truncated: false, body: { kind: "text" as const, content } },
    });
    const cyrillic = pageOfFetch(page("ж".repeat(30_000)), 0, 24_000);
    expect(Buffer.byteLength(cyrillic.content.body.content)).toBeLessThanOrEqual(WEB_FETCH_PAGE_BYTES);
    expect(cyrillic.page?.nextOffset).toBe(cyrillic.content.body.content.length);
    const emoji = pageOfFetch(page(`a${"😀".repeat(10)}`), 0, 4);
    expect(emoji.content.body.content).toBe("a😀");
    expect(emoji.page?.nextOffset).toBe(3);
  });

  it("asks for the same fetch on every page: the binding sees the URL alone", () => {
    expect(fetchRequestOf({ url: "https://a.example/", offset: 16_000, maxChars: 8_000 })).toEqual(
      fetchRequestOf({ url: "https://a.example/" }),
    );
  });
});
