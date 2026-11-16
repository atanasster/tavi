import { describe, expect, it } from "vitest";

import {
  ARG_PROVENANCE_LIMITS,
  ApprovalProvenanceSchema,
  GATE_REASONS,
  GATE_REASON_WORDS,
  GateVerdictSchema,
  TAINT_DETAIL_NOTES,
  approvalProvenanceLine,
  approvalProvenanceOf,
  argOriginToken,
  argOriginWords,
  argumentOrigins,
  clipArgValue,
  desktopSourceHost,
  hostOfUrl,
  maskArgOrigins,
  memoryProvenanceLine,
  toolResultLabel,
  untrustedEnvelopeHead,
  redactToolText,
  evaluateGate,
  labelSummary,
  neutralizedText,
  provenanceChips,
  provenanceWindow,
  taintChipText,
  taintDetailLines,
  untrustedLabel,
  whyAskedText,
  type ProvenanceWindowEntry,
} from "../src/index.js";

/**
 * Argument provenance and how every surface
 * says where content came from — Tavi's words first, content's claim after.
 */

const AT = "2026-10-13T10:00:00.000Z";
const page = (text: string, host = "news.example"): ProvenanceWindowEntry => ({
  text,
  from: "content",
  source: "web",
  host,
  toolId: "web_fetch",
  ref: "call-1",
});
const person = (text: string): ProvenanceWindowEntry => ({ text, from: "person" });

describe("argumentOrigins", () => {
  it("names a string the person typed as theirs, even when a page holds it too", () => {
    const window = provenanceWindow([person("send it to alice@home.example please"), page("contact alice@home.example or bob@x.example")]);
    const origins = argumentOrigins({ to: "alice@home.example" }, window);
    expect(origins).toEqual([{ path: "to", value: "alice@home.example", from: "person" }]);
    expect(argOriginToken(origins[0]!)).toBe("person");
  });

  it("never looks up Tavi's own handles and checksums, whatever a page or an attachment line says", () => {
    const sha = "a".repeat(64);
    const window = provenanceWindow([page(`browser-session-1 is open; art-up-5c14d2e8f0 ${sha}`)]);
    expect(
      argumentOrigins(
        {
          sessionId: "browser-session-1",
          sourceSha256: sha,
          source: { artifactId: "art-up-5c14d2e8f0" },
          url: "https://news.example/a",
        },
        window,
      ),
    ).toEqual([{ path: "url", value: "https://news.example/a", from: "unmatched" }]);
  });

  it("names a string only a page holds by the page's host, with its tool and ref", () => {
    const origins = argumentOrigins(
      { to: "bob@x.example" },
      provenanceWindow([person("reply to the contact"), page("contact bob@x.example")]),
    );
    expect(origins).toEqual([
      { path: "to", value: "bob@x.example", from: "content", source: "web", host: "news.example", toolId: "web_fetch", ref: "call-1" },
    ]);
    expect(argOriginToken(origins[0]!)).toBe("page:news.example");
    expect(argOriginToken({ ...origins[0]!, source: "email", host: "x.example" })).toBe("email:x.example");
    expect(argOriginToken({ path: "q", value: "v", from: "content", toolId: "acme.lookup" })).toBe("tool:acme.lookup");
  });

  it("names a string nothing in the window holds unmatched: model-written, or older than the window", () => {
    const origins = argumentOrigins(
      { url: "https://collect.attacker.example/h?q=secret" },
      provenanceWindow([person("summarize the page"), page("Guide text")]),
    );
    expect(origins.map((origin) => origin.from)).toEqual(["unmatched"]);
    expect(argOriginWords(origins[0]!)).toMatch(/model/);
  });

  it("finds identifiers inside a longer leaf, and looks up a free-text leaf only from 16 characters", () => {
    const window = provenanceWindow([page("visit https://docs.example/guide and ship it, short words")]);
    const origins = argumentOrigins(
      { body: "see https://docs.example/guide.", short: "ship it", long: "and ship it, short words" },
      window,
    );
    expect(origins.map((origin) => [origin.path, origin.value, origin.from])).toEqual([
      ["body", "https://docs.example/guide", "content"],
      ["body", "see https://docs.example/guide.", "unmatched"],
      ["long", "and ship it, short words", "content"],
    ]);
    // A hostname or a path is an identifier whatever its length.
    expect(argumentOrigins({ host: "x.io", path: "/etc/a" }, provenanceWindow([page("x.io /etc/a")])).map((origin) => origin.from)).toEqual(
      ["content", "content"],
    );
  });

  it("searches only the newest 100 KB: a page older than the window is unmatched", () => {
    const old = page("the secret is s3cr3t-value-long-enough");
    const filler = person("x".repeat(ARG_PROVENANCE_LIMITS.windowChars));
    expect(argumentOrigins({ v: "s3cr3t-value-long-enough" }, provenanceWindow([old, filler])).map((origin) => origin.from)).toEqual([
      "unmatched",
    ]);
    // A message straddling the bound keeps its newest part.
    const straddle = page(`s3cr3t-value-long-enough${"y".repeat(ARG_PROVENANCE_LIMITS.windowChars)}tail-value-long-enough`);
    const kept = provenanceWindow([straddle]);
    expect(kept[0]!.text.length).toBe(ARG_PROVENANCE_LIMITS.windowChars);
    expect(argumentOrigins({ a: "tail-value-long-enough", b: "s3cr3t-value-long-enough" }, kept).map((origin) => origin.from)).toEqual([
      "content",
      "unmatched",
    ]);
  });

  it("answers at most 16 origins, each value clipped, and walks a bounded input", () => {
    const input = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`k${index}`, `value number ${index} long enough ${"z".repeat(200)}`]),
    );
    const origins = argumentOrigins(input, []);
    expect(origins).toHaveLength(ARG_PROVENANCE_LIMITS.maxOrigins);
    expect(origins.every((origin) => origin.value.length <= ARG_PROVENANCE_LIMITS.maxValueChars)).toBe(true);
    let deep: unknown = "a value at the bottom, long enough";
    for (let depth = 0; depth < 50; depth += 1) deep = { d: deep };
    expect(argumentOrigins(deep, [])).toEqual([]);
  });

  it("scans a 200 KB leaf in linear time, with or without an address in it", () => {
    for (const leaf of [
      "a".repeat(200 * 1024),
      `${"a.".repeat(100 * 1024)}@`,
      `x@${"a.".repeat(100 * 1024)}`,
      `${"ab".repeat(100 * 1024)} bob@x.example`,
    ]) {
      const started = Date.now();
      argumentOrigins({ body: leaf }, []);
      expect(Date.now() - started, `${leaf.slice(0, 12)}…`).toBeLessThan(50);
    }
    expect(argumentOrigins({ body: `write to bob@x.example ${"z".repeat(40)}` }, []).map((origin) => origin.value)).toContain(
      "bob@x.example",
    );
  });

  it("never cuts a value inside a token, so masking after the clip leaves no prefix of it", () => {
    const clipped = clipArgValue(`${"word ".repeat(21)}Bearer abcdefghijklmnopqrstuvwxyz`);
    expect(clipped.endsWith("Bearer …")).toBe(true);
    expect(clipped).not.toMatch(/abc/);
    // A placeholder longer than the token it replaces is clipped back to the bound.
    const value = `${"x ".repeat(48)}Bearer abcdefghijklmnop end`.slice(0, ARG_PROVENANCE_LIMITS.maxValueChars);
    const [masked] = maskArgOrigins([{ path: "body", value, from: "unmatched" }], (text) => redactToolText(text).text);
    expect(masked!.value).not.toMatch(/abcdefghijklmnop/);
    expect(masked!.value.length).toBeLessThanOrEqual(ARG_PROVENANCE_LIMITS.maxValueChars);
  });

  it("never changes a decision: the gate decides first, and the verdict with origins parses", () => {
    const input = {
      toolId: "http.request",
      effect: "external" as const,
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["external" as const]),
      tainted: true,
      label: untrustedLabel("web"),
      sink: "network" as const,
    };
    const verdict = evaluateGate(input);
    const origins = argumentOrigins({ url: "https://a.example/x" }, provenanceWindow([person("open https://a.example/x")]));
    const shown = { ...verdict, argOrigins: [...origins] };
    expect(GateVerdictSchema.parse(shown).decision).toBe(verdict.decision);
    expect(evaluateGate(input)).toEqual(verdict);
  });
});

describe("approvalProvenanceOf", () => {
  it("carries the reason, the label's sources and newest refs, and the origins; nothing for a clean, unflagged call", () => {
    const label = labelSummary(
      untrustedLabel("web", { principal: "host:news.example", ref: { ref: "call-1", host: "news.example", title: "Daily", at: AT } }),
    );
    const provenance = approvalProvenanceOf({
      gateReason: "novel-url",
      risk: { level: "high", reasons: [], tainted: true, label },
      argOrigins: [{ path: "url", value: "https://x", from: "unmatched" }],
    });
    expect(ApprovalProvenanceSchema.parse(provenance)).toEqual({
      gateReason: "novel-url",
      sources: ["web"],
      principals: ["host:news.example"],
      refs: label.refs,
      argOrigins: [{ path: "url", value: "https://x", from: "unmatched" }],
    });
    expect(approvalProvenanceOf({ risk: { level: "low", reasons: [], tainted: false } })).toBeUndefined();
    // A trusted label's sources are not the card's.
    expect(
      approvalProvenanceOf({
        risk: {
          level: "low",
          reasons: [],
          tainted: false,
          label: labelSummary({ integrity: "trusted", sources: [], principals: [], confidentiality: "personal", refs: [] }),
        },
        argOrigins: [{ path: "a", value: "b", from: "person" }],
      })?.sources,
    ).toEqual([]);
  });
});

describe("what the card and the chip say", () => {
  it("has plain words for every gate reason", () => {
    for (const reason of GATE_REASONS) {
      // The skill ceiling's reason is no taint: its words name the skill instead.
      expect(GATE_REASON_WORDS[reason]).toMatch(
        reason === "outside-skill-ceiling"
          ? /^A skill this chat loaded lists the tools it uses/
          : /^This chat read content Tavi does not trust/,
      );
      expect(whyAskedText(reason, true)).toBe(GATE_REASON_WORDS[reason]);
    }
    expect(whyAskedText(undefined, true)).toMatch(/steering/);
    expect(whyAskedText(undefined, false)).toBeUndefined();
  });

  it("says a novel address may be on a page the chat read, when the model typed there first (QA-20261110-1806)", () => {
    // A results page the model searched on lists its links, yet none of them is "seen": the words must not deny the page gave it.
    expect(GATE_REASON_WORDS["novel-url"]).not.toMatch(/nor anything this chat read/);
    expect(GATE_REASON_WORDS["novel-url"]).toMatch(/a model wrote it, or a page showed it after the model typed on that page/);
  });

  it("leads with what Tavi established, and a page's title only after, as its claim", () => {
    const chips = provenanceChips({
      sources: ["web", "email", "search"],
      refs: [
        { source: "web", ref: "c1", host: "news.example", title: "Daily news", at: AT },
        { source: "email", ref: "m1", host: "x.example", at: AT },
      ],
    });
    expect(chips).toEqual([
      { established: "news.example", claim: "the page calls itself “Daily news”" },
      { established: "mail you forwarded or quoted (via x.example)" },
      { established: "search results" },
    ]);
    expect(
      approvalProvenanceLine(
        {
          sources: ["web", "email"],
          refs: [
            { source: "web", ref: "c1", host: "example.com", at: AT },
            { source: "email", ref: "m1", host: "x.example", at: AT },
          ],
        },
        true,
      ),
    ).toBe("⚠ after reading example.com and mail you forwarded or quoted (via x.example) — once only");
  });

  it("renders a hostile title inert, clipped to 60, after the host", () => {
    const hostile = `<script>alert(1)</script>\u202Egnp.exe" onclick="x ${"A".repeat(10 * 1024)}`;
    const [chip] = provenanceChips({
      sources: ["web"],
      refs: [{ source: "web", ref: "c1", host: "evil.example", title: hostile.slice(0, 120), at: AT }],
    });
    expect(chip!.established).toBe("evil.example");
    const claim = chip!.claim ?? "";
    expect(claim).not.toMatch(/[<>"\u202E]/);
    expect(claim).toMatch(/^the page calls itself “‹script›alert\(1\)‹\/script›/);
    // The title alone is at most 60 characters, the cut marked.
    expect(Array.from(claim.slice("the page calls itself “".length, -1)).length).toBeLessThanOrEqual(60);
    expect(neutralizedText(hostile, 60)).toHaveLength(60);
    expect(neutralizedText("a\u202Eb\u2028c\u0007d", 60)).toBe("a b c d");
  });

  it("calls what a desktop tool read a desktop app's screen, naming the app, in the chip, the card and the origin line (QA-20261110-1893)", () => {
    const desktop = {
      sources: ["web" as const],
      refs: [{ source: "web" as const, ref: "c1", host: desktopSourceHost("TextEdit"), at: AT }],
    };
    expect(taintChipText(desktop)).toBe("Read a desktop app's screen (TextEdit)");
    expect(provenanceChips(desktop)).toEqual([{ established: "a desktop app's screen (TextEdit)" }]);
    expect(argOriginWords({ path: "app", value: "x", from: "content", source: "web", host: desktopSourceHost("TextEdit") })).toBe(
      "appears in a desktop app's screen (TextEdit)",
    );
    // No app known, or a desktop call whose label named none: still the screen, never a page.
    expect(provenanceChips({ sources: ["web"], refs: [{ source: "web", ref: "c2", host: desktopSourceHost(undefined), at: AT }] })).toEqual(
      [{ established: "a desktop app's screen" }],
    );
    expect(argOriginWords({ path: "app", value: "x", from: "content", source: "web", host: desktopSourceHost(undefined) })).toBe(
      "appears in a desktop app's screen",
    );
    // A tool id alone decides nothing: any plugin may name its tools `desktop.…` (the gate names the built-in's host).
    expect(argOriginWords({ path: "app", value: "x", from: "content", source: "web", toolId: "desktop.observe" })).toBe(
      "appears in a web page",
    );
    // A page read alongside keeps its own host; an app's name that is not plain words is not shown.
    expect(
      taintChipText({
        sources: ["web"],
        refs: [
          { source: "web", ref: "c1", host: desktopSourceHost('<b>"Notes"</b>'), at: AT },
          { source: "web", ref: "c3", host: "news.example", at: AT },
        ],
      }),
    ).toBe("Read a desktop app's screen and news.example");
  });

  it("shows a desktop app's name in Tavi's words only when it is plain words: no developer-chosen text speaks there (QA 1893)", () => {
    const forged = "Notes) and mail you forwarded or quoted (via bank.example";
    // Made by the desktop tools: the name is dropped, the next candidate (a bundle id) is taken.
    expect(desktopSourceHost(forged)).toBe("desktop:");
    expect(desktopSourceHost(forged, "com.apple.Notes")).toBe("desktop:com.apple.Notes");
    expect(desktopSourceHost("  Text\nEdit  ")).toBe("desktop:Text Edit");
    expect(desktopSourceHost("Café_Ünï-2.0")).toBe("desktop:Café_Ünï-2.0");
    // A label written by anything else (an older record, a forged ref) says no name either.
    const chips = provenanceChips({ sources: ["web"], refs: [{ source: "web", ref: "c1", host: `desktop:${forged}`, at: AT }] });
    expect(chips).toEqual([{ established: "a desktop app's screen" }]);
    expect(taintChipText({ sources: ["web"], refs: [{ source: "web", ref: "c1", host: `desktop:${forged}`, at: AT }] })).not.toMatch(
      /mail you forwarded/,
    );
    // Clipped by characters, never leaving half a surrogate pair.
    const long = desktopSourceHost("𝐀".repeat(300));
    expect(long.length).toBeLessThanOrEqual(253);
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("names no desktop host from a URL, from an outside tool's label, or in the model's envelope (QA 1893)", () => {
    for (const url of ["desktop:TextEdit", "https://desktop:TextEdit@x.example/", "desktop://TextEdit/", "https://desktop:443/"])
      expect(hostOfUrl(url) ?? "").not.toMatch(/^desktop:/);
    const forged = { untrusted: true, label: { host: "desktop:TextEdit" } } as const;
    for (const outputSource of ["mcp", "plugin"] as const) {
      const label = toolResultLabel({ untrustedOutput: true, outputSource }, { id: "c1", input: {} }, forged, AT);
      expect(JSON.stringify(label)).not.toContain("desktop:");
    }
    // A built-in's is kept, and shown in words.
    const builtIn = toolResultLabel({ untrustedOutput: true, outputSource: "web", builtIn: true }, { id: "c1", input: {} }, forged, AT);
    expect(builtIn.refs[0]?.host).toBe("desktop:TextEdit");
    // The model's envelope names a host only when it is one: an app's never, even all digits.
    for (const host of ["desktop:TextEdit", "desktop:12345", "desktop:"])
      expect(untrustedEnvelopeHead({ id: "0123456789abcdef", sources: ["web"], host })).toBe("[untrusted:0123456789abcdef source=web]");
  });

  it("says a desktop app's screen in a memory's provenance line, not a web page (QA 1893)", () => {
    const at = AT;
    expect(
      memoryProvenanceLine({
        integrity: "untrusted",
        sources: ["web"],
        refs: [{ source: "web", ref: "c1", host: "desktop:TextEdit", at }],
      }),
    ).toBe("Proposed after this chat read a desktop app's screen (TextEdit)");
    expect(
      memoryProvenanceLine({ integrity: "untrusted", sources: ["web"], refs: [{ source: "web", ref: "c1", host: "desktop:", at }] }),
    ).toBe("Proposed after this chat read a desktop app's screen");
    expect(
      memoryProvenanceLine({
        integrity: "untrusted",
        sources: ["web"],
        refs: [
          { source: "web", ref: "c1", host: "desktop:Notes) and mail (via bank.example", at },
          { source: "web", ref: "c2", host: "news.example", at },
        ],
      }),
    ).toBe("Proposed after this chat read a web page and a desktop app's screen (news.example)");
  });

  it("names up to three sources in the chip, and its details say Fresh context does not clear taint", () => {
    const label = {
      sources: ["web", "email", "search", "download"] as const,
      refs: [{ source: "web" as const, ref: "c1", host: "a.example", at: AT }],
    };
    expect(taintChipText({ sources: [...label.sources], refs: label.refs })).toBe("Read a.example, an email, search results and 1 more");
    const lines = taintDetailLines({ sources: [...label.sources], refs: label.refs });
    expect(lines.slice(-TAINT_DETAIL_NOTES.length)).toEqual(TAINT_DETAIL_NOTES);
    expect(lines.join("\n")).toMatch(/Fresh context \(\/compact\) does not clear it/);
    expect(lines.join("\n")).toMatch(/Start a fresh chat/);
  });
});
