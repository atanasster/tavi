import { describe, expect, it } from "vitest";

import {
  CONTENT_LABEL_LIMITS,
  type ContentLabel,
  ContentLabelSchema,
  isPrivate,
  isUntrusted,
  joinLabels,
  type LabelRef,
  LabelRefSchema,
  LabelSummarySchema,
  labelSummary,
  labelSummaryBytes,
  normalizeLabel,
  SourceKindSchema,
  TRUSTED_PUBLIC,
  trustedLabel,
  UNTRUSTED_UNKNOWN_SOURCE,
  untrustedLabel,
} from "../src/index.js";

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES = SourceKindSchema.options;
// Few distinct values so unions overlap, duplicate keys recur and caps bite.
const PRINCIPALS = Array.from({ length: 30 }, (_, i) => `member:c:${i}`).concat(["host:é", "host:\u{1F600}", "host:�"]);
const TIMES = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`).concat([
  "2026-10-01T00:00:00.000Z", // the same instant as day 1, written differently
]);

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function randomLabel(next: () => number): ContentLabel {
  const refs: LabelRef[] = [];
  const refCount = Math.floor(next() * 40);
  for (let i = 0; i < refCount; i += 1) {
    refs.push({
      source: pick(next, SOURCES.slice(0, 3)),
      ref: `r${Math.floor(next() * 25)}`,
      ...(next() < 0.3 ? { host: pick(next, ["a.example", "b.example"]) } : {}),
      ...(next() < 0.3 ? { title: pick(next, ["One", "Two"]) } : {}),
      at: pick(next, TIMES),
    });
  }
  return {
    integrity: next() < 0.5 ? "trusted" : "untrusted",
    sources: Array.from({ length: Math.floor(next() * 5) }, () => pick(next, SOURCES)),
    principals: Array.from({ length: Math.floor(next() * 20) }, () => pick(next, PRINCIPALS)),
    confidentiality: pick(next, ["public", "personal", "secret"] as const),
    refs,
  };
}

const json = (label: ContentLabel): string => JSON.stringify(label);
const RUNS = 600;

describe("joinLabels is a semilattice join", () => {
  it("is commutative, byte for byte", () => {
    const next = rng(1);
    for (let i = 0; i < RUNS; i += 1) {
      const a = randomLabel(next);
      const b = randomLabel(next);
      expect(json(joinLabels(a, b))).toBe(json(joinLabels(b, a)));
    }
  });

  it("is associative, byte for byte, including truncation of principals and refs", () => {
    const next = rng(2);
    let truncatedPrincipals = 0;
    let truncatedRefs = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const a = randomLabel(next);
      const b = randomLabel(next);
      const c = randomLabel(next);
      const left = joinLabels(joinLabels(a, b), c);
      const right = joinLabels(a, joinLabels(b, c));
      expect(json(left)).toBe(json(right));
      if (new Set([...a.principals, ...b.principals, ...c.principals]).size > 16) truncatedPrincipals += 1;
      if (new Set([...a.refs, ...b.refs, ...c.refs].map((r) => `${r.source}:${r.ref}`)).size > 32) truncatedRefs += 1;
    }
    expect(truncatedPrincipals).toBeGreaterThan(50);
    expect(truncatedRefs).toBeGreaterThan(50);
  });

  it("is idempotent on its own output, and joining a label with itself canonicalizes it", () => {
    const next = rng(3);
    for (let i = 0; i < RUNS; i += 1) {
      const a = randomLabel(next);
      const n = normalizeLabel(a);
      expect(json(joinLabels(a, a))).toBe(json(n));
      expect(json(joinLabels(n, n))).toBe(json(n));
      expect(json(normalizeLabel(n))).toBe(json(n));
    }
  });

  it("has TRUSTED_PUBLIC as its identity", () => {
    const next = rng(4);
    for (let i = 0; i < RUNS; i += 1) {
      const n = normalizeLabel(randomLabel(next));
      expect(json(joinLabels(n, TRUSTED_PUBLIC))).toBe(json(n));
      expect(json(joinLabels(TRUSTED_PUBLIC, n))).toBe(json(n));
    }
  });

  it("gives the same bytes for any fold order over many labels", () => {
    const next = rng(5);
    for (let i = 0; i < 100; i += 1) {
      const labels = Array.from({ length: 6 }, () => randomLabel(next));
      const forward = labels.reduce(joinLabels, TRUSTED_PUBLIC);
      const shuffled = [...labels].sort(() => next() - 0.5).reduce(joinLabels, TRUSTED_PUBLIC);
      expect(json(shuffled)).toBe(json(forward));
    }
  });

  it("always produces a valid label", () => {
    const next = rng(6);
    for (let i = 0; i < RUNS; i += 1) {
      expect(ContentLabelSchema.safeParse(joinLabels(randomLabel(next), randomLabel(next))).success).toBe(true);
    }
  });
});

describe("joinLabels, field by field", () => {
  const ref = (id: string, at: string, extra: Partial<LabelRef> = {}): LabelRef => ({
    source: "web",
    ref: id,
    at,
    ...extra,
  });

  it("takes integrity min and confidentiality max", () => {
    const personal = trustedLabel("personal");
    const joined = joinLabels(personal, untrustedLabel("web"));
    expect(joined.integrity).toBe("untrusted");
    expect(joined.confidentiality).toBe("personal");
    expect(joinLabels(joined, trustedLabel("secret")).confidentiality).toBe("secret");
  });

  it("unions sources in enum order", () => {
    const joined = joinLabels(untrustedLabel("unknown-source"), joinLabels(untrustedLabel("web"), untrustedLabel("mcp")));
    expect(joined.sources).toEqual(["web", "mcp", "unknown-source"]);
  });

  it("keeps the 16 smallest principals in code-point order", () => {
    const many: ContentLabel = { ...TRUSTED_PUBLIC, principals: ["host:�", "host:\u{1F600}"] };
    // U+1F600 is greater than U+FFFD in code points, though smaller in UTF-16 units.
    expect(normalizeLabel(many).principals).toEqual(["host:�", "host:\u{1F600}"]);
    const twenty: ContentLabel = {
      ...TRUSTED_PUBLIC,
      principals: Array.from({ length: 20 }, (_, i) => `p${String(19 - i).padStart(2, "0")}`),
    };
    expect(normalizeLabel(twenty).principals).toEqual(Array.from({ length: 16 }, (_, i) => `p${String(i).padStart(2, "0")}`));
  });

  it("keeps the 32 newest refs, newest first, the key breaking ties", () => {
    const at = "2026-10-01T00:00:00Z";
    const label: ContentLabel = {
      ...TRUSTED_PUBLIC,
      refs: [
        ...Array.from({ length: 30 }, (_, i) => ref(`old${i}`, "2026-09-01T00:00:00Z")),
        ref("b", at),
        ref("a", at),
        ref("c", at),
        ref("new", "2026-10-02T00:00:00Z"),
      ],
    };
    const refs = normalizeLabel(label).refs;
    expect(refs).toHaveLength(32);
    expect(refs.slice(0, 4).map((r) => r.ref)).toEqual(["new", "c", "b", "a"]);
  });

  it("dedupes refs by source:ref, keeping one entry per key whatever the order", () => {
    const early = ref("x", "2026-10-01T00:00:00Z", { title: "early" });
    const late = ref("x", "2026-10-05T00:00:00Z", { title: "late" });
    const other = { ...late, source: "mcp" as const };
    const ab = joinLabels({ ...TRUSTED_PUBLIC, refs: [early] }, { ...TRUSTED_PUBLIC, refs: [late, other] });
    const ba = joinLabels({ ...TRUSTED_PUBLIC, refs: [late, other] }, { ...TRUSTED_PUBLIC, refs: [early] });
    expect(json(ab)).toBe(json(ba));
    expect(ab.refs.filter((r) => r.source === "web")).toHaveLength(1);
    expect(ab.refs).toHaveLength(2);
  });

  it("stays associative when a key's old duplicate would be truncated in one grouping", () => {
    // The counterexample to keeping the earlier `at`: x holds K long ago, y holds
    // 32 newer refs, z holds K recently.
    const x: ContentLabel = { ...TRUSTED_PUBLIC, refs: [ref("K", "2026-01-01T00:00:00Z")] };
    const y: ContentLabel = {
      ...TRUSTED_PUBLIC,
      refs: Array.from({ length: 32 }, (_, i) => ref(`y${i}`, `2026-02-01T00:00:${String(i).padStart(2, "0")}Z`)),
    };
    const z: ContentLabel = { ...TRUSTED_PUBLIC, refs: [ref("K", "2026-03-01T00:00:00Z")] };
    const left = joinLabels(joinLabels(x, y), z);
    expect(json(left)).toBe(json(joinLabels(x, joinLabels(y, z))));
    expect(left.refs[0]).toEqual(ref("K", "2026-03-01T00:00:00Z"));
  });

  it("writes keys in one fixed order", () => {
    const messy = { at: "2026-10-01T00:00:00Z", title: "T", host: "h.example", ref: "r", source: "web" } as LabelRef;
    expect(Object.keys(normalizeLabel({ ...TRUSTED_PUBLIC, refs: [messy] }).refs[0] ?? {})).toEqual([
      "source",
      "ref",
      "host",
      "title",
      "at",
    ]);
    const shuffled = { refs: [], confidentiality: "public", principals: [], sources: [], integrity: "trusted" } as ContentLabel;
    expect(json(normalizeLabel(shuffled))).toBe(json(TRUSTED_PUBLIC));
  });
});

describe("constants and helpers", () => {
  it("reads a bare taint flag as untrusted, public, from an unknown source", () => {
    expect(UNTRUSTED_UNKNOWN_SOURCE).toEqual({
      integrity: "untrusted",
      sources: ["unknown-source"],
      principals: [],
      confidentiality: "public",
      refs: [],
    });
    expect(json(normalizeLabel(UNTRUSTED_UNKNOWN_SOURCE))).toBe(json(UNTRUSTED_UNKNOWN_SOURCE));
    expect(isUntrusted(UNTRUSTED_UNKNOWN_SOURCE)).toBe(true);
    expect(() => (UNTRUSTED_UNKNOWN_SOURCE.sources as string[]).push("web")).toThrow(TypeError);
    expect(() => TRUSTED_PUBLIC.refs.push({ source: "web", ref: "r", at: "2026-10-01T00:00:00Z" })).toThrow(TypeError);
    expect(() => TRUSTED_PUBLIC.principals.push("p")).toThrow(TypeError);
    expect(TRUSTED_PUBLIC.sources).toEqual([]);
    const personal = trustedLabel("personal");
    expect(personal.refs).not.toBe(TRUSTED_PUBLIC.refs);
    personal.principals.push("p");
    expect(TRUSTED_PUBLIC.principals).toEqual([]);
    expect(isPrivate(UNTRUSTED_UNKNOWN_SOURCE)).toBe(false);
  });

  it("builds an untrusted label with its principal and ref", () => {
    const label = untrustedLabel("web", {
      principal: "host:a.example",
      ref: { ref: "call-1", host: "a.example", at: "2026-10-01T00:00:00Z" },
      confidentiality: "personal",
    });
    expect(label).toEqual({
      integrity: "untrusted",
      sources: ["web"],
      principals: ["host:a.example"],
      confidentiality: "personal",
      refs: [{ source: "web", ref: "call-1", host: "a.example", at: "2026-10-01T00:00:00Z" }],
    });
    expect(ContentLabelSchema.parse(label)).toEqual(label);
    expect(isUntrusted(label) && isPrivate(label)).toBe(true);
    expect(isUntrusted(TRUSTED_PUBLIC) || isPrivate(TRUSTED_PUBLIC)).toBe(false);
  });
});

describe("schema bounds", () => {
  const at = "2026-10-01T00:00:00Z";

  it("bounds a ref's fields and rejects unknown keys", () => {
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r".repeat(200), at }).success).toBe(true);
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r".repeat(201), at }).success).toBe(false);
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r", host: "h".repeat(254), at }).success).toBe(false);
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r", title: "t".repeat(121), at }).success).toBe(false);
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r", at: "yesterday" }).success).toBe(false);
    expect(LabelRefSchema.safeParse({ source: "nope", ref: "r", at }).success).toBe(false);
    expect(LabelRefSchema.safeParse({ source: "web", ref: "r", at, extra: 1 }).success).toBe(false);
  });

  it("bounds a label's lists and rejects unknown keys", () => {
    expect(SourceKindSchema.options).toHaveLength(16);
    const base = { ...TRUSTED_PUBLIC };
    expect(ContentLabelSchema.safeParse({ ...base, principals: Array(16).fill("p") }).success).toBe(true);
    expect(ContentLabelSchema.safeParse({ ...base, principals: Array(17).fill("p") }).success).toBe(false);
    expect(ContentLabelSchema.safeParse({ ...base, principals: ["p".repeat(161)] }).success).toBe(false);
    const refs = Array.from({ length: 33 }, (_, i) => ({ source: "web", ref: `r${i}`, at }));
    expect(ContentLabelSchema.safeParse({ ...base, refs: refs.slice(0, 32) }).success).toBe(true);
    expect(ContentLabelSchema.safeParse({ ...base, refs }).success).toBe(false);
    expect(ContentLabelSchema.safeParse({ ...base, sources: Array(17).fill("web") }).success).toBe(false);
    expect(ContentLabelSchema.safeParse({ ...base, tainted: true }).success).toBe(false);
  });
});

describe("labelSummary", () => {
  it("carries integrity, sources, principals, confidentiality and the 5 newest refs", () => {
    const label = Array.from({ length: 8 }, (_, i) =>
      untrustedLabel("web", { ref: { ref: `r${i}`, at: `2026-10-0${i + 1}T00:00:00Z` } }),
    ).reduce(joinLabels, trustedLabel("personal"));
    const summary = labelSummary(label);
    expect(summary).toEqual({
      integrity: "untrusted",
      sources: ["web"],
      principals: [],
      confidentiality: "personal",
      refs: label.refs.slice(0, 5),
    });
    expect(summary.refs.map((r) => r.ref)).toEqual(["r7", "r6", "r5", "r4", "r3"]);
    expect(labelSummary(label, 2).refs).toHaveLength(2);
    expect(labelSummary(label, 0).refs).toEqual([]);
    expect(() => labelSummary(label, 6)).toThrow(RangeError);
    expect(() => labelSummary(label, -1)).toThrow(RangeError);
    expect(() => labelSummary(label, 1.5)).toThrow(RangeError);
  });

  it("drops ref titles first, keeping every ref, when that alone fits", () => {
    const label: ContentLabel = {
      ...TRUSTED_PUBLIC,
      principals: Array.from({ length: 16 }, (_, i) => `${String.fromCharCode(65 + i)}${"\u0001".repeat(30)}`),
      refs: Array.from({ length: 5 }, (_, i) => ({
        source: "web" as const,
        ref: `r${i}`,
        title: "\u{1F600}".repeat(60),
        at: `2026-10-01T00:00:0${i}Z`,
      })),
    };
    const summary = labelSummary(label);
    expect(summary.truncated).toBe(true);
    expect(summary.refs.map((r) => r.ref)).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(summary.refs.every((r) => r.title === undefined)).toBe(true);
    expect(summary.principals).toEqual(normalizeLabel(label).principals);
  });

  it("stays within 4 KiB of UTF-8 JSON at the worst case, dropping display detail first", () => {
    // Control characters escape to six bytes each in JSON; astral ones are four bytes.
    const heavy = (seed: string, length: number) => `${seed}${"\u0001".repeat(length - 1)}`;
    const label: ContentLabel = {
      integrity: "untrusted",
      sources: [...SourceKindSchema.options],
      principals: Array.from({ length: 16 }, (_, i) => heavy(String.fromCharCode(65 + i), 160)),
      confidentiality: "secret",
      refs: Array.from({ length: 32 }, (_, i) => ({
        source: "web" as const,
        ref: heavy(`r${i}`, 200),
        host: "h".repeat(253),
        title: "\u{1F600}".repeat(60),
        at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
      })),
    };
    const summary = labelSummary(label);
    expect(labelSummaryBytes(summary)).toBeLessThanOrEqual(CONTENT_LABEL_LIMITS.summaryMaxBytes);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length).toBe(labelSummaryBytes(summary));
    expect(summary).toMatchObject({ integrity: "untrusted", confidentiality: "secret", truncated: true });
    expect(summary.sources).toHaveLength(16);
    // Refs went from the oldest, then principals from the greatest.
    const canonical = normalizeLabel(label);
    expect(summary.refs).toEqual(canonical.refs.slice(0, summary.refs.length).map(({ title: _t, ...rest }) => rest));
    expect(summary.principals).toEqual(canonical.principals.slice(0, summary.principals.length));
    expect(summary.refs.length).toBeLessThan(5);
    expect(summary.principals.length).toBeLessThan(16);
    expect(LabelSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("stays within the bound for random labels", () => {
    const next = rng(7);
    for (let i = 0; i < 200; i += 1) {
      const summary = labelSummary(randomLabel(next));
      expect(labelSummaryBytes(summary)).toBeLessThanOrEqual(CONTENT_LABEL_LIMITS.summaryMaxBytes);
      expect(LabelSummarySchema.safeParse(summary).success).toBe(true);
      expect(summary.truncated).toBeUndefined();
    }
  });
});
