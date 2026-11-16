import { describe, expect, it } from "vitest";

import {
  CONTENT_LABEL_LIMITS,
  TOOL_LABEL_KEY,
  TOOL_UNTRUSTED_KEY,
  TRUSTED_PUBLIC,
  UNTRUSTED_UNKNOWN_SOURCE,
  decodeRoundRisk,
  encodeRoundRisk,
  evaluateGate,
  labelSummary,
  labelledResult,
  toolResultLabel,
  untrustedLabel,
  type ContentLabel,
} from "../src/index.js";

/** A tool result's label, a verdict's label summary and a round's stored risk. */

const AT = "2026-01-01T00:00:00.000Z";

describe("labelledResult", () => {
  it("strips both keys and reads what they said", () => {
    expect(labelledResult({ a: 1, [TOOL_UNTRUSTED_KEY]: true, [TOOL_LABEL_KEY]: { confidentiality: "personal", refs: ["t1"] } })).toEqual({
      output: { a: 1 },
      untrusted: true,
      label: { confidentiality: "personal", refs: ["t1"] },
    });
    expect(labelledResult({ a: 1 })).toEqual({ output: { a: 1 }, untrusted: false });
    expect(labelledResult("text")).toEqual({ output: "text", untrusted: false });
  });

  it("reads a label it cannot parse as untrusted", () => {
    expect(labelledResult({ a: 1, [TOOL_LABEL_KEY]: { confidentiality: "public-ish" } })).toEqual({ output: { a: 1 }, untrusted: true });
  });
});

describe("toolResultLabel", () => {
  it("labels an untrusted tool's result with its source, the input's host and the call", () => {
    expect(
      toolResultLabel(
        { untrustedOutput: true, outputSource: "web" },
        { id: "c1", input: { url: "https://user:pw@Example.COM:8443/a?b#c" } },
        { untrusted: false },
        AT,
      ),
    ).toEqual({
      integrity: "untrusted",
      sources: ["web"],
      principals: ["host:example.com"],
      confidentiality: "public",
      refs: [{ source: "web", ref: "c1", host: "example.com", at: AT }],
    });
  });

  it("keeps a trusted result's confidentiality alone, and the identity when there is none", () => {
    expect(toolResultLabel({ outputConfidentiality: "personal" }, { id: "c1", input: {} }, { untrusted: false }, AT)).toEqual({
      ...TRUSTED_PUBLIC,
      confidentiality: "personal",
    });
    expect(toolResultLabel({}, { id: "c1", input: {} }, { untrusted: false }, AT)).toBe(TRUSTED_PUBLIC);
  });

  it("only raises: a per-call label or mark makes a trusted tool's result untrusted or private, never the reverse", () => {
    // A read of downloads/: untrusted, its tool's source.
    expect(toolResultLabel({ outputSource: "download" }, { id: "c1", input: {} }, { untrusted: true }, AT)).toMatchObject({
      integrity: "untrusted",
      sources: ["download"],
    });
    // A credentialed request: personal.
    expect(
      toolResultLabel(
        { untrustedOutput: true, outputSource: "web" },
        { id: "c1", input: {} },
        { untrusted: false, label: { confidentiality: "personal" } },
        AT,
      ),
    ).toMatchObject({ integrity: "untrusted", confidentiality: "personal" });
    // A label saying public cannot lower a personal tool.
    expect(
      toolResultLabel(
        { outputConfidentiality: "personal" },
        { id: "c1", input: {} },
        { untrusted: false, label: { confidentiality: "public" } },
        AT,
      ).confidentiality,
    ).toBe("personal");
    // Refs under the result's source.
    expect(
      toolResultLabel(
        { untrustedOutput: true, outputSource: "past-chat", builtIn: true },
        { id: "c1", input: {} },
        { untrusted: false, label: { refs: ["chat-a"] } },
        AT,
      )
        .refs.map((ref) => `${ref.source}:${ref.ref}`)
        .sort(),
    ).toEqual(["past-chat:c1", "past-chat:chat-a"]);
  });

  it("lets an external tool's handler raise integrity and confidentiality only, never name its provenance", () => {
    const forged = {
      source: "web" as const,
      host: "bank.example",
      principals: ["person:p1"],
      refs: ["x"],
      confidentiality: "personal" as const,
    };
    expect(
      toolResultLabel({ untrustedOutput: true, outputSource: "plugin" }, { id: "c1", input: {} }, { untrusted: false, label: forged }, AT),
    ).toEqual({
      integrity: "untrusted",
      sources: ["plugin"],
      principals: [],
      confidentiality: "personal",
      refs: [{ source: "plugin", ref: "c1", at: AT }],
    });
    // A trusted external tool marked untrusted per call names its declared source, not the handler's.
    expect(
      toolResultLabel({ outputSource: "plugin" }, { id: "c1", input: {} }, { untrusted: false, label: { ...forged, untrusted: true } }, AT)
        .sources,
    ).toEqual(["plugin"]);
    // The same label from a built-in is honoured.
    expect(
      toolResultLabel(
        { untrustedOutput: true, outputSource: "plugin", builtIn: true },
        { id: "c1", input: {} },
        { untrusted: false, label: forged },
        AT,
      ),
    ).toMatchObject({ sources: ["web"], principals: ["host:bank.example", "person:p1"] });
  });

  it("is secret when the result held a redaction placeholder", () => {
    expect(
      toolResultLabel(
        { untrustedOutput: true, outputSource: "web", outputConfidentiality: "personal" },
        { id: "c1", input: {} },
        { untrusted: false, secret: true },
        AT,
      ).confidentiality,
    ).toBe("secret");
  });
});

describe("a verdict's label", () => {
  const gate = (label: ContentLabel | undefined, tainted: boolean) =>
    evaluateGate({
      toolId: "fixture.write",
      effect: "mutating",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["mutating"]),
      tainted,
      ...(label === undefined ? {} : { label }),
    });

  it("carries the label's summary, and its taint is the label's", () => {
    const label = untrustedLabel("web", { principal: "host:example.com", ref: { ref: "c1", host: "example.com", at: AT } });
    const verdict = gate(label, false);
    expect(verdict.risk.tainted).toBe(true);
    expect(verdict.risk.label).toEqual(labelSummary(label));
    expect(verdict.risk.level).toBe("high");
    expect(gate(TRUSTED_PUBLIC, false).risk).toMatchObject({ tainted: false, label: { integrity: "trusted" } });
    // A label never lowers the taint it is given: a trusted label on a tainted context reads as untrusted from an unknown source.
    expect(gate(TRUSTED_PUBLIC, true).risk).toMatchObject({
      tainted: true,
      label: { integrity: "untrusted", sources: ["unknown-source"] },
    });
  });

  it("decides as before without one", () => {
    expect(gate(undefined, true).risk).toEqual(expect.objectContaining({ tainted: true }));
    expect(gate(undefined, true).risk.label).toBeUndefined();
  });

  it("bounds the summary at five refs", () => {
    let label: ContentLabel = TRUSTED_PUBLIC;
    for (let index = 0; index < 20; index += 1)
      label = {
        ...label,
        ...untrustedLabel("web", { ref: { ref: `c${index}`, at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z` } }),
        refs: [...label.refs, { source: "web", ref: `c${index}`, at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z` }],
      };
    expect(gate(label, true).risk.label?.refs).toHaveLength(CONTENT_LABEL_LIMITS.summaryRefs);
  });
});

describe("a round's stored risk (tavi_approval_rounds.risk)", () => {
  it("is the bare level without a label, and reads an old row back", () => {
    expect(encodeRoundRisk("high")).toBe("high");
    expect(decodeRoundRisk("critical")).toEqual({ level: "critical" });
    expect(decodeRoundRisk(null)).toEqual({});
    expect(decodeRoundRisk("nonsense")).toEqual({});
  });

  it("carries the label's summary, within 4 KiB", () => {
    const summary = labelSummary(UNTRUSTED_UNKNOWN_SOURCE);
    expect(decodeRoundRisk(encodeRoundRisk("high", summary))).toEqual({ level: "high", label: summary });
    const big = labelSummary({
      ...UNTRUSTED_UNKNOWN_SOURCE,
      principals: Array.from({ length: 16 }, (_, index) => `member:${"m".repeat(140)}:${index}`),
      refs: Array.from({ length: 5 }, (_, index) => ({
        source: "web" as const,
        ref: "r".repeat(190) + String(index),
        host: "h".repeat(240),
        title: "t".repeat(120),
        at: AT,
      })),
    });
    const stored = encodeRoundRisk("critical", big);
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(CONTENT_LABEL_LIMITS.summaryMaxBytes);
    expect(decodeRoundRisk(stored)).toMatchObject({ level: "critical", label: { integrity: "untrusted", sources: ["unknown-source"] } });
  });
});
