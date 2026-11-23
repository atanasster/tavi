import { describe, expect, it } from "vitest";

import {
  BROWSER_TITLE_MAX,
  BROWSER_URL_MAX,
  DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS,
  clipBrowserTitle,
  hostBlocksThumbnail,
  normalizeNoThumbnailHost,
  scrubBrowserUrl,
} from "../src/browser-history.js";
import { isModelVisibleArtifact } from "../src/ports.js";
import { BrowserListAnswerSchema, formatBrowserDuration, parseCommandPayload } from "../src/index.js";
import { coreIn } from "../src/locales/core-server.js";

/** Browser history's storage rules. */
describe("scrubBrowserUrl", () => {
  it("keeps scheme, host, port and path, and drops the query string, fragment and userinfo", () => {
    expect(scrubBrowserUrl("https://example.com/a/b?token=secret&q=search#section")).toBe("https://example.com/a/b");
    expect(scrubBrowserUrl("https://user:pass@example.com/private")).toBe("https://example.com/private");
    expect(scrubBrowserUrl("http://example.com:8080/x?y=1")).toBe("http://example.com:8080/x");
    // A default port is not a port worth keeping.
    expect(scrubBrowserUrl("https://example.com:443/")).toBe("https://example.com/");
    expect(scrubBrowserUrl("https://EXAMPLE.com")).toBe("https://example.com/");
    expect(scrubBrowserUrl("http://[::1]:3000/admin?k=v")).toBe("http://[::1]:3000/admin");
  });

  it("stores an internationalized host in its ASCII form", () => {
    expect(scrubBrowserUrl("https://bücher.de/katalog?seite=2")).toBe("https://xn--bcher-kva.de/katalog");
  });

  it("keeps only the scheme of a non-web URL, whose path can be its content", () => {
    expect(scrubBrowserUrl("about:blank")).toBe("about:blank");
    expect(scrubBrowserUrl("data:text/html,<p>secret</p>")).toBe("data:");
    expect(scrubBrowserUrl("chrome-error://chromewebdata/")).toBe("chrome-error:");
    expect(scrubBrowserUrl("not a url")).toBeUndefined();
  });

  it("clips a long path", () => {
    const scrubbed = scrubBrowserUrl(`https://example.com/${"a".repeat(5000)}?x=1`);
    expect(scrubbed).toHaveLength(BROWSER_URL_MAX);
    expect(scrubbed?.startsWith("https://example.com/aaa")).toBe(true);
  });
});

describe("clipBrowserTitle", () => {
  it("strips control characters, trims and clips", () => {
    expect(clipBrowserTitle("  Inbox\u0000 (3)\n- Mail \u0007")).toBe("Inbox (3) - Mail");
    expect(clipBrowserTitle("x".repeat(1000))).toHaveLength(BROWSER_TITLE_MAX);
    expect(clipBrowserTitle(" \n ")).toBeUndefined();
    expect(clipBrowserTitle(undefined)).toBeUndefined();
    expect(clipBrowserTitle(null)).toBeUndefined();
  });
});

describe("the no-thumbnail hosts", () => {
  it("match an exact host, and a *. pattern matches the domain and its subdomains", () => {
    const hosts = ["mail.example.com", "*.bank", "*.paypal.com"];
    expect(hostBlocksThumbnail("https://mail.example.com/u/0", hosts)).toBe(true);
    expect(hostBlocksThumbnail("https://www.example.com/", hosts)).toBe(false);
    expect(hostBlocksThumbnail("https://mybank.bank/login", hosts)).toBe(true);
    expect(hostBlocksThumbnail("https://paypal.com/", hosts)).toBe(true);
    expect(hostBlocksThumbnail("https://www.PAYPAL.com./", hosts)).toBe(true);
    expect(hostBlocksThumbnail("https://notpaypal.com/", hosts)).toBe(false);
    expect(hostBlocksThumbnail("about:blank", hosts)).toBe(false);
    expect(hostBlocksThumbnail("https://mail.google.com/mail/u/0/#inbox", DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS)).toBe(true);
  });

  it("compare an internationalized host in its ASCII form", () => {
    expect(hostBlocksThumbnail("https://bücher.de/", ["bücher.de"])).toBe(true);
    expect(hostBlocksThumbnail("https://xn--bcher-kva.de/", ["*.bücher.de"])).toBe(true);
  });

  it("normalize an entry or refuse one that is not a host", () => {
    expect(normalizeNoThumbnailHost(" *.Example.COM ")).toBe("*.example.com");
    expect(normalizeNoThumbnailHost("example.com.")).toBe("example.com");
    for (const bad of ["", "*.", "https://a.com", "a.com/x", "a.com:80", "user@a.com", "a b.com"]) {
      expect(normalizeNoThumbnailHost(bad)).toBeUndefined();
    }
  });
});

describe("isModelVisibleArtifact", () => {
  it("hides internal artifacts (a browser thumbnail) from every model-facing path", () => {
    expect(isModelVisibleArtifact({})).toBe(true);
    expect(isModelVisibleArtifact({ purpose: "thumbnail" })).toBe(false);
  });
});

describe("the browser IPC contract", () => {
  it("bounds list and visit pages and takes nothing else", () => {
    expect(parseCommandPayload("browser", { action: "list", workspaceId: "default", open: true, limit: 50 }).ok).toBe(true);
    expect(parseCommandPayload("browser", { action: "visits", sessionId: "s1", limit: 200 }).ok).toBe(true);
    for (const input of [
      { action: "list", limit: 51 },
      { action: "list", cursor: "../x" },
      { action: "visits" },
      { action: "visits", sessionId: "s1", limit: 201 },
      { action: "list", url: "https://example.com" },
      { action: "delete", sessionId: "s1" },
    ]) {
      expect(parseCommandPayload("browser", input).ok, JSON.stringify(input)).toBe(false);
    }
    expect(BrowserListAnswerSchema.safeParse({ items: [] }).success).toBe(true);
  });
});

describe("formatBrowserDuration", () => {
  it("says seconds, minutes and hours", () => {
    expect(formatBrowserDuration(45_000)).toBe("45 s");
    expect(formatBrowserDuration(18 * 60_000 + 59_000)).toBe("18 min");
    expect(formatBrowserDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatBrowserDuration(120 * 60_000)).toBe("2 h");
  });

  it("says them in Bulgarian, with a no-break space before each unit", () => {
    const bg = coreIn("bg");
    expect(formatBrowserDuration(6_000, bg)).toBe("6\u00a0сек");
    expect(formatBrowserDuration(60_000, bg)).toBe("1\u00a0мин");
    expect(formatBrowserDuration(125 * 60_000, bg)).toBe("2\u00a0ч 5\u00a0мин");
    expect(formatBrowserDuration(120 * 60_000, bg)).toBe("2\u00a0ч");
  });
});
