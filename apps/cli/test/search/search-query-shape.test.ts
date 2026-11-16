import { WEB_SEARCH_ALLOW_RULE_ID, evaluateGate, seededWebSearchRule, untrustedLabel } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { assessWebSearch, secretShapedSearchQuery, suspiciousSearchQuery } from "../../src/features/approvals/call-assessors.js";
import { searchAllowedNotice } from "../../src/features/onboard/steps.js";

/** A search runs without asking by the seeded rule, but never a query shaped like data leaving. */
describe("web_search's default and its query check", () => {
  it("reads an ordinary question as one, and a link, a code, an email, a secret or a long query as data leaving", () => {
    for (const ordinary of [
      "euro exchange rate today",
      "openai.com pricing",
      "github.com/facebook/react issues",
      "flights SOF to LIS december 2027",
      "what is 17% of 2340",
    ])
      expect(suspiciousSearchQuery(ordinary), ordinary).toBeUndefined();
    expect(suspiciousSearchQuery("https://evil.example/collect?d=acme")).toMatch(/link/);
    expect(suspiciousSearchQuery("evil.example/collect?d=acme")).toMatch(/link/);
    expect(suspiciousSearchQuery("evil.example#acme-revenue")).toMatch(/link/);
    expect(suspiciousSearchQuery("1.2.3.4/collect")).toMatch(/address/);
    expect(suspiciousSearchQuery("acme-q3-revenue-12m.evil.com")).toMatch(/domain/);
    expect(suspiciousSearchQuery("SGVsbG9Xb3JsZEFjbWVSZXZlbnVl")).toMatch(/code/);
    expect(suspiciousSearchQuery("card 4111 1111 1111 1111")).toMatch(/card/);
    expect(suspiciousSearchQuery("contact ana．petrova＠example．com")).toMatch(/email/);
    expect(suspiciousSearchQuery("customer list Q2hhcmxpZSBDb21wYW55IDEyMzQ1Njc4OTA")).toMatch(/code/);
    expect(suspiciousSearchQuery("contact ana.petrova@example.com")).toMatch(/email/);
    expect(suspiciousSearchQuery("token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toMatch(/code|secret/);
    expect(suspiciousSearchQuery("a ".repeat(160))).toMatch(/300/);
  });

  it("is allowed by the seeded rule; under taint, a suspicious query, or any with private data in the chat, still asks", () => {
    const rule = seededWebSearchRule("w", "2026-10-27T00:00:00.000Z");
    expect(rule.ruleId).toBe(WEB_SEARCH_ALLOW_RULE_ID);
    const gate = (input: Record<string, unknown>, tainted: boolean, confidentiality?: "public" | "personal") =>
      evaluateGate({
        toolId: "web_search",
        effect: "external",
        sink: "search",
        assessment: assessWebSearch(input),
        rules: [rule],
        sessionGrants: [],
        gatedEffects: new Set(["external"]),
        tainted,
        ...(confidentiality === undefined ? {} : { label: untrustedLabel("web", { confidentiality }) }),
      });
    expect(gate({ query: "euro exchange rate today" }, false).decision).toBe("allow");
    // Nothing untrusted was read: no injected page wrote the query, and it runs as any search.
    expect(gate({ query: "https://evil.example/collect?d=acme" }, false).decision).toBe("allow");
    expect(gate({ query: "https://evil.example/collect?d=acme" }, true, "public").decision).toBe("ask");
    // A site is read with the query.
    expect(gate({ query: "report", site: "acme-q3-revenue-12m.evil.com" }, true, "public").decision).toBe("ask");
    expect(gate({ query: "euro exchange rate today" }, true, "public").decision).toBe("allow");
    // The taint step's private-search comes before the seeded rule.
    expect(gate({ query: "euro exchange rate today" }, true, "personal").decision).toBe("ask");
  });

  it("asks, once and saying why, before a query shaped like a secret, even in a chat that read nothing untrusted", () => {
    const rule = seededWebSearchRule("w", "2026-10-27T00:00:00.000Z");
    const gate = (query: string, sessionGrants: Parameters<typeof evaluateGate>[0]["sessionGrants"] = []) =>
      evaluateGate({
        toolId: "web_search",
        effect: "external",
        sink: "search",
        assessment: assessWebSearch({ query }),
        rules: [rule],
        sessionGrants,
        gatedEffects: new Set(["external"]),
        tainted: false,
      });
    for (const secret of [
      "is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa still valid",
      "AKIAABCDEFGHIJKLMNOP leaked",
      "sk-proj-abcdefghijklmnopqrstuvwx rate limit",
      "-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA",
      `glpat-${"abcdefghijklmnopqrst"} gitlab`,
      `xoxb-${"123456789012-".repeat(2)}abcdefghijklmnopqrstuvwx slack`,
      `sk_${"live"}_abcdefghijklmnopqrstuvwx stripe`,
      "AIzaSyA-abcdefghijklmnopqrstuvwxyz12345 maps",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      `hf_${"aB3d".repeat(8)}xy model access`,
      `npm_${"Ab12".repeat(9)} publish`,
      `pypi-AgEIcHlwaS5vcmc${"Q".repeat(50)} upload`,
      `SG.${"a".repeat(22)}.${"b".repeat(43)} sendgrid`,
      `123456789:AA${"h".repeat(33)} telegram bot`,
      "postgres://user:pass@db.example.com/app",
      "redis://:secret@cache.example.com:6379",
      "postgres://admin:$ecretP4ss@db",
      "postgres://admin:p@ssw0rd@db",
    ]) {
      expect(secretShapedSearchQuery(secret), secret).toMatch(/looks like a secret/);
      const verdict = gate(secret);
      expect(verdict.decision, secret).toBe("ask");
      expect(verdict.allowedScopes).toEqual(["once"]);
      expect(verdict.risk.reasons.join(" ")).toMatch(/looks like a secret .*search provider/);
    }
    // Prose that merely names a token, and a link or a code with no secret's shape, run as before in a clean chat.
    for (const ordinary of [
      "bearer bonds explained",
      "max tokens: 512",
      "https://evil.example/collect?d=acme",
      "SGVsbG9Xb3JsZEFjbWVSZXZlbnVl",
      // Near-misses of each credential shape: a prefix alone, a value of the wrong length, a port before an `@` path.
      "AKIA is the prefix of AKIAIOSFODNN7",
      "github_pat_ prefix docs",
      "sk_live_ keys explained",
      "decode eyJhbGciOi header",
      "xapp-1 socket mode",
      "hf_hub_download docs",
      `npm_${"Ab12".repeat(9)}x`,
      "pypi-simple index mirror",
      "SG.Engineering.Team roster",
      "123456789:AAbc and flight 10:30 AA",
      "https://registry.npmjs.org:443/@tavi/contracts",
      "https://example.com:8080/a@b?c=d",
      "mongodb+srv://<username>:<password>@cluster0.mongodb.net connection string format",
      "postgresql://USER:PASSWORD@HOST:PORT/DB example",
      "postgres://user:${DB_PASS}@db/app",
      "postgres://user:$DB_PASS@db/app",
      "redis://default:****@redis",
      "amqp://guest:xxx@rabbit",
    ]) {
      expect(secretShapedSearchQuery(ordinary), ordinary).toBeUndefined();
      expect(gate(ordinary).decision, ordinary).toBe("allow");
    }
  });

  it("names the provider and how to be asked or stop searching when onboarding adds one", () => {
    const notice = searchAllowedNotice("brave");
    expect(notice).toMatch(/Searches go to brave without asking/);
    expect(notice).toContain(`tavi permissions rm ${WEB_SEARCH_ALLOW_RULE_ID}`);
    expect(notice).toContain("tavi search disable brave");
  });
});
