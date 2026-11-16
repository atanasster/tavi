import { describe, expect, it } from "vitest";

import {
  AgentStateDataSchema,
  boundEventPayloads,
  boundTurnKnownUrls,
  TURN_KNOWN_URLS_LIMITS,
  TurnKnownUrlsSchema,
  extractFragmentUrls,
  extractUrls,
  GateVerdictSchema,
  isKnownNavigation,
  isKnownUrl,
  KNOWN_URL_LIMITS,
  KnownUrlsSchema,
  knownUrlSet,
  mergeKnownUrls,
  mergeUrlKeys,
  navigationKeyOf,
  normalizeUrl,
  urlKeysIn,
} from "../src/index.js";

describe("normalizeUrl", () => {
  it("gives an empty path as / so https://a.example and https://a.example/ are one URL", () => {
    expect(normalizeUrl("https://a.example")).toBe("https://a.example/");
    expect(normalizeUrl("https://a.example/")).toBe("https://a.example/");
    expect(normalizeUrl("https://a.example?q=1")).toBe("https://a.example/?q=1");
  });

  it("drops default ports and keeps others", () => {
    expect(normalizeUrl("https://a.example:443/x")).toBe("https://a.example/x");
    expect(normalizeUrl("http://a.example:80/x")).toBe("http://a.example/x");
    expect(normalizeUrl("https://a.example:8443/x")).toBe("https://a.example:8443/x");
    expect(normalizeUrl("http://a.example:443/x")).toBe("http://a.example:443/x");
  });

  it("lower-cases scheme and host but not path or query", () => {
    expect(normalizeUrl("HTTPS://A.Example/Path?Q=Value")).toBe("https://a.example/Path?Q=Value");
    expect(normalizeUrl("https://a.example/Path")).not.toBe(normalizeUrl("https://a.example/path"));
  });

  it("keeps the query byte for byte: not re-encoded, not reordered", () => {
    expect(normalizeUrl("https://a.example/s?q=a b&x='y'")).toBe("https://a.example/s?q=a b&x='y'");
    expect(normalizeUrl("https://a.example/s?q=a%20b")).toBe("https://a.example/s?q=a%20b");
    expect(normalizeUrl("https://a.example/s?q=a b")).not.toBe(normalizeUrl("https://a.example/s?q=a%20b"));
    expect(normalizeUrl("https://a.example/s?a=1&b=2")).not.toBe(normalizeUrl("https://a.example/s?b=2&a=1"));
    expect(normalizeUrl("https://a.example/s?")).toBe("https://a.example/s?");
  });

  it("drops the fragment, including one that holds a ?", () => {
    expect(normalizeUrl("https://a.example/x?q=1#top")).toBe("https://a.example/x?q=1");
    expect(normalizeUrl("https://a.example/x#frag?notquery")).toBe("https://a.example/x");
  });

  it("puts an IDN host in punycode, so both spellings are one URL", () => {
    expect(normalizeUrl("https://bücher.example/a")).toBe("https://xn--bcher-kva.example/a");
    expect(normalizeUrl("https://BÜCHER.example/a")).toBe("https://xn--bcher-kva.example/a");
    expect(normalizeUrl("https://xn--bcher-kva.example/a")).toBe("https://xn--bcher-kva.example/a");
  });

  it("keeps userinfo, so it cannot ride on a known address", () => {
    expect(normalizeUrl("https://secret@a.example/")).toBe("https://secret@a.example/");
    expect(normalizeUrl("https://secret@a.example/")).not.toBe(normalizeUrl("https://a.example/"));
    // Userinfo added to a known URL makes a novel one, so it cannot carry data out under a known address.
    expect(isKnownUrl("https://SECRET:x@a.example/page", knownUrlSet(["https://a.example/page"]))).toBe(false);
  });

  it("refuses non-web, unparseable and control-bearing input", () => {
    expect(normalizeUrl("ftp://a.example/")).toBeUndefined();
    expect(normalizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeUrl("mailto:a@b.example")).toBeUndefined();
    expect(normalizeUrl("https://")).toBeUndefined();
    expect(normalizeUrl("not a url")).toBeUndefined();
    expect(normalizeUrl("https://a.example/x?q=1\n2")).toBeUndefined();
  });

  it("never normalizes a URL longer than 2,048 characters", () => {
    const base = "https://a.example/";
    const atCap = base + "a".repeat(KNOWN_URL_LIMITS.maxUrlLength - base.length);
    expect(atCap).toHaveLength(2048);
    expect(normalizeUrl(atCap)).toBe(atCap);
    expect(normalizeUrl(atCap + "a")).toBeUndefined();
    // Under the cap as written, over it once the path is percent-encoded.
    const encodedOver = base + "é".repeat(700);
    expect(normalizeUrl(encodedOver)).toBeUndefined();
  });

  it("refuses Unicode white space at either end, which the request would carry", () => {
    for (const space of ["\u00a0", "\u2003", "\u3000", "\ufeff", "\u2009\u200a"]) {
      expect(normalizeUrl(`https://a.example/c${space}`)).toBeUndefined();
      expect(normalizeUrl(`https://a.example/c?q=1${space}`)).toBeUndefined();
      expect(normalizeUrl(`${space}https://a.example/c`)).toBeUndefined();
      expect(isKnownUrl(`https://a.example/c${space}`, knownUrlSet(["https://a.example/c"]))).toBe(false);
    }
    expect(normalizeUrl("  https://a.example/c  ")).toBe("https://a.example/c");
  });

  it("refuses a query ending in a space before the fragment, which would not normalize stably", () => {
    expect(normalizeUrl("https://a.example/x?q=1 #f")).toBeUndefined();
    expect(normalizeUrl("https://a.example/x?q=a b#f")).toBe("https://a.example/x?q=a b");
  });

  it("is idempotent", () => {
    for (const raw of ["https://A.example:443", "https://bücher.example/ä?q=ä b#x", "http://a.example/./b/../c?z=1&a=2"]) {
      const once = normalizeUrl(raw);
      expect(once).toBeDefined();
      expect(normalizeUrl(once ?? "")).toBe(once);
    }
  });
});

describe("isKnownUrl", () => {
  const known = knownUrlSet(["https://a.example/report?id=7&lang=en", "https://b.example"]);

  it("matches exactly after normalization", () => {
    expect(isKnownUrl("HTTPS://A.EXAMPLE:443/report?id=7&lang=en#summary", known)).toBe(true);
    expect(isKnownUrl("https://b.example/", known)).toBe(true);
  });

  it("never matches a URL the model composed or extended", () => {
    expect(isKnownUrl("https://a.example/report/extra?id=7&lang=en", known)).toBe(false);
    expect(isKnownUrl("https://a.example/report?id=7&lang=en&leak=secret", known)).toBe(false);
    expect(isKnownUrl("https://a.example/report?lang=en&id=7", known)).toBe(false);
    expect(isKnownUrl("https://a.example/report", known)).toBe(false);
    expect(isKnownUrl("https://b.example/secret", known)).toBe(false);
    expect(isKnownUrl("https://b.example/?secret", known)).toBe(false);
    expect(isKnownUrl("https://evil.b.example/", known)).toBe(false);
    expect(isKnownUrl("http://b.example/", known)).toBe(false);
  });

  it("matches redirect hops as the absolute URLs a fetch reports", () => {
    const hops = knownUrlSet(["https://short.example/r/abc", "https://www.target.example/article?id=9"]);
    expect(isKnownUrl("https://www.target.example/article?id=9", hops)).toBe(true);
    expect(isKnownUrl("https://www.target.example/article?id=10", hops)).toBe(false);
  });

  it("never knows an over-long URL, even one in the set's source text", () => {
    const long = "https://a.example/" + "x".repeat(2100);
    expect(isKnownUrl(long, knownUrlSet([long]))).toBe(false);
  });
});

describe("extractUrls", () => {
  it("reads page links as htmlToText writes them", () => {
    const page = "Results\n- Annual report (https://a.example/annual?y=2025) and the appendix (https://a.example/app#p2).";
    expect(extractUrls(page)).toEqual(["https://a.example/annual?y=2025", "https://a.example/app"]);
  });

  it("reads Markdown links, angle brackets and sentence punctuation", () => {
    expect(extractUrls("See [the docs](https://docs.example/guide). Or <https://b.example/x>, then https://c.example!")).toEqual([
      "https://docs.example/guide",
      "https://b.example/x",
      "https://c.example/",
    ]);
  });

  it("keeps balanced parentheses inside a URL", () => {
    expect(extractUrls("(see https://en.wiki.example/wiki/Foo_(bar))")).toEqual(["https://en.wiki.example/wiki/Foo_(bar)"]);
  });

  it("returns each URL once, normalized, and skips non-web schemes", () => {
    expect(extractUrls("HTTPS://A.example and https://a.example/ and ftp://x.example and mailto:a@b.example")).toEqual([
      "https://a.example/",
    ]);
  });
});

describe("mergeKnownUrls", () => {
  const urls = (n: number, prefix = "u"): string[] => Array.from({ length: n }, (_, i) => `https://a.example/${prefix}${i}`);

  it("normalizes and dedupes, moving a repeat to the newest end", () => {
    expect(
      mergeKnownUrls(["https://a.example/1", "https://a.example/2"], ["HTTPS://A.EXAMPLE/1", "ftp://x", "https://a.example/3"]),
    ).toEqual(["https://a.example/2", "https://a.example/1", "https://a.example/3"]);
  });

  it("keeps the newest 2,000 and evicts the oldest", () => {
    const merged = mergeKnownUrls(urls(1500, "old"), urls(1000, "new"));
    expect(merged).toHaveLength(KNOWN_URL_LIMITS.maxUrls);
    expect(merged[0]).toBe("https://a.example/old500");
    expect(merged.at(-1)).toBe("https://a.example/new999");
    expect(merged).not.toContain("https://a.example/old499");
    expect(KnownUrlsSchema.safeParse(merged).success).toBe(true);
    // An evicted URL is no longer known: it is asked about again.
    expect(isKnownUrl("https://a.example/old0", new Set(merged))).toBe(false);
  });

  it("is idempotent", () => {
    const a = urls(5, "a");
    const b = ["https://a.example/a2", ...urls(3, "b")];
    const once = mergeKnownUrls(a, b);
    expect(mergeKnownUrls(once, b)).toEqual(once);
    expect(mergeKnownUrls(once, [])).toBe(once);
  });

  it("is associative, including across eviction", () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const sample = (n: number): string[] => Array.from({ length: n }, () => `https://a.example/${Math.floor(random() * 2600)}`);
    for (let round = 0; round < 20; round += 1) {
      const a = mergeKnownUrls([], sample(Math.floor(random() * 2200)));
      const b = sample(Math.floor(random() * 1500));
      const c = sample(Math.floor(random() * 1500));
      expect(mergeKnownUrls(mergeKnownUrls(a, b), c)).toEqual(mergeKnownUrls(a, mergeKnownUrls(b, c)));
    }
  });
});

describe("navigations compare the fragment", () => {
  it("keys a navigation by its normal form and its fragment as written", () => {
    expect(navigationKeyOf("HTTPS://A.example/p#Sec")).toBe("https://a.example/p#Sec");
    expect(navigationKeyOf("https://a.example/p#")).toBe("https://a.example/p");
    expect(navigationKeyOf("https://a.example/p")).toBe("https://a.example/p");
  });

  it("knows a fragment only when the conversation held it on that URL", () => {
    const text = "See https://a.example/p#install and https://a.example/q.";
    const known = new Set([...extractUrls(text), ...extractFragmentUrls(text)]);
    expect(extractFragmentUrls(text)).toEqual(["https://a.example/p#install"]);
    expect(isKnownNavigation("https://a.example/p#install", known)).toBe(true);
    expect(isKnownNavigation("https://a.example/p", known)).toBe(true);
    expect(isKnownNavigation("https://a.example/q", known)).toBe(true);
    // A model-appended fragment carries data to page script: not known, though a fetch would drop it.
    expect(isKnownNavigation("https://a.example/q#d=secret", known)).toBe(false);
    expect(isKnownUrl("https://a.example/q#d=secret", known)).toBe(true);
  });
});

describe("legacy checkpoints", () => {
  it("read a state from before the knownUrls channel as knowing none, and a verdict from before the taint step as it was", () => {
    const state = AgentStateDataSchema.parse({
      stateVersion: 1,
      runId: "task-1",
      phase: "running",
      invocation: { workspaceId: "ws-1", principalId: "p-1", runId: "task-1", caller: "cli" },
    });
    expect(state.knownUrls).toEqual([]);
    const verdict = {
      toolId: "web_fetch",
      decision: "ask",
      risk: { level: "high", reasons: [], tainted: true },
      allowedScopes: ["once", "session"],
      display: { title: "Fetch" },
    };
    expect(GateVerdictSchema.parse(verdict)).toEqual(verdict);
  });
});

describe("URL keys", () => {
  it("keys a text's URLs by their normal forms and, with a fragment, their navigation keys", () => {
    expect(urlKeysIn("Go to https://A.example/p#top and https://a.example/q")).toEqual([
      "https://a.example/p",
      "https://a.example/q",
      "https://a.example/p#top",
    ]);
  });

  it("merges keys keeping fragments, bounded and newest kept", () => {
    expect(mergeUrlKeys([], ["https://a.example/p#Top", "HTTPS://a.example/q", "not a url"])).toEqual([
      "https://a.example/p#Top",
      "https://a.example/q",
    ]);
    const many = Array.from({ length: KNOWN_URL_LIMITS.maxUrls + 3 }, (_, index) => `https://a.example/${index}`);
    const merged = mergeUrlKeys([], many);
    expect(merged).toHaveLength(KNOWN_URL_LIMITS.maxUrls);
    expect(merged.at(-1)).toBe(`https://a.example/${KNOWN_URL_LIMITS.maxUrls + 2}`);
  });
});

describe("a tainted turn's known URLs, for the canvas", () => {
  it("keeps the newest URL keys within the bounds, oldest first, leaving out ones not in key form and repeats", () => {
    expect(boundTurnKnownUrls(["https://a.example/", "https://b.example/#x", "HTTPS://C.example", "https://a.example/"])).toEqual([
      "https://b.example/#x",
      "https://a.example/",
    ]);
    const many = Array.from({ length: TURN_KNOWN_URLS_LIMITS.maxUrls + 10 }, (_, index) => `https://h${index}.example/`);
    const bounded = boundTurnKnownUrls(many);
    expect(bounded).toHaveLength(TURN_KNOWN_URLS_LIMITS.maxUrls);
    expect(bounded.at(-1)).toBe(many.at(-1));
    expect(TurnKnownUrlsSchema.safeParse(bounded).success).toBe(true);
    const long = Array.from({ length: 100 }, (_, index) => `https://h${index}.example/${"p".repeat(2000)}`);
    expect(boundTurnKnownUrls(long).join("").length).toBeLessThanOrEqual(TURN_KNOWN_URLS_LIMITS.maxChars);
  });

  it("is bounded on an event as it enters the stream", () => {
    const many = Array.from({ length: TURN_KNOWN_URLS_LIMITS.maxUrls + 1 }, (_, index) => `https://h${index}.example/`);
    expect((boundEventPayloads({ kind: "text.delta", knownUrls: many }).knownUrls as string[]).length).toBe(TURN_KNOWN_URLS_LIMITS.maxUrls);
  });

  it("finds a link familiar only when the conversation holds it exactly, as disarmUrls does", () => {
    const known = new Set(["https://docs.example/guide?a=1", "https://docs.example/page#part"]);
    expect(isKnownNavigation("https://DOCS.example/guide?a=1", known)).toBe(true);
    expect(isKnownNavigation("https://docs.example/page#part", known)).toBe(true);
    // Another page on a known host is novel: a page the turn read is on a known host, and could plant one.
    expect(isKnownNavigation("https://docs.example/other", known)).toBe(false);
    expect(isKnownNavigation("https://docs.example/guide?a=1&q=secret", known)).toBe(false);
    // A fragment the model appended to a known page is novel: page script reads it.
    expect(isKnownNavigation("https://docs.example/guide?a=1#secret", known)).toBe(false);
    expect(isKnownNavigation("https://attacker.example/?q=secret", known)).toBe(false);
    expect(isKnownNavigation("https://docs.example.attacker.example/", known)).toBe(false);
    // An over-long URL is never known.
    expect(isKnownNavigation(`https://docs.example/${"x".repeat(KNOWN_URL_LIMITS.maxUrlLength)}`, known)).toBe(false);
  });
});
