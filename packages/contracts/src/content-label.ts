/**
 * The content label: what a
 * piece of context came from and what would leak if it went out. It replaces
 * the single taint bit: integrity (may this text steer actions?) and
 * confidentiality (what would leak?) are separate axes, with the sources,
 * principals and bounded refs that say *why*.
 *
 * `joinLabels` is a semilattice join (associative, commutative, idempotent on
 * its own output), so the checkpoint reducer, folds and replays agree, and its
 * output is canonical: equal inputs give byte-identical JSON in any join order.
 *
 * Rule of Two in these terms: [A] is `isUntrusted`, [B] is `isPrivate`.
 *
 * Pure: no I/O, no clock.
 */
import { z } from "zod";

export const SourceKindSchema = z.enum([
  "web", // web_fetch, browser.*
  "search", // web_search, news.search, travel.*
  "email", // an inbound email's quoted or forwarded part, or an unverified email
  "chat-other", // a chat message from someone other than the task's person
  "chat-forward", // a forwarded chat message
  "attachment", // channel media (media-intake)
  "download", // managed downloads/
  "mcp", // an MCP result, resource or prompt
  "plugin", // an external plugin result, a mod's context block
  "agent", // a worker's or peer's message carrying an untrusted label
  "past-chat", // sessions.search
  "routine-output", // reports, routine runs, collect.daily, findings
  "heartbeat", // heartbeat signals, page excerpts (heartbeat.fetch), an item's Do it / Chat about this
  "sandbox", // sandbox.run output while downloads/ holds files or after a run reached a granted host; a tainted chat's folder
  "webhook", // what a call to a schedule's webhook carried
  "unknown-source", // untrusted from a source not named: a bare taint flag, a stored label that does not parse
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Ordered: `public < personal < secret`. */
export const ConfidentialitySchema = z.enum(["public", "personal", "secret"]);
export type Confidentiality = z.infer<typeof ConfidentialitySchema>;

export const IntegritySchema = z.enum(["trusted", "untrusted"]);
export type Integrity = z.infer<typeof IntegritySchema>;

/**
 * What a desktop tool's result names as its host (QA 1893): `desktop:` and the
 * app, when known. Desktop content keeps the `web` source kind, so the gate
 * treats it as a page's; only the words differ (`provenance-display.ts`). No
 * host Tavi parses from a URL has this form (`hostOfUrl`).
 */
export const DESKTOP_HOST_PREFIX = "desktop:";

export const CONTENT_LABEL_LIMITS = {
  maxSources: 16,
  maxPrincipals: 16,
  maxPrincipalLength: 160,
  maxRefs: 32,
  maxRefLength: 200,
  maxHostLength: 253,
  maxTitleLength: 120,
  /** Refs a verdict's label summary carries. */
  summaryRefs: 5,
  /** UTF-8 bytes of a summary's JSON; it rides in `tavi_approval_rounds.risk`. */
  summaryMaxBytes: 4096,
} as const;

export const LabelRefSchema = z.strictObject({
  source: SourceKindSchema,
  /** Tool call id, artifact id, message id. */
  ref: z.string().max(CONTENT_LABEL_LIMITS.maxRefLength),
  /** What Tavi parsed: page host, verified sender domain. */
  host: z.string().max(CONTENT_LABEL_LIMITS.maxHostLength).optional(),
  /** What the content says about itself; display only. */
  title: z.string().max(CONTENT_LABEL_LIMITS.maxTitleLength).optional(),
  at: z.iso.datetime(),
});
export type LabelRef = z.infer<typeof LabelRefSchema>;

export const ContentLabelSchema = z.strictObject({
  integrity: IntegritySchema,
  sources: z.array(SourceKindSchema).max(CONTENT_LABEL_LIMITS.maxSources),
  /** "person:<id>", "member:<conn>:<sender>", "host:<h>", "tool:<id>", "agent:<task>". */
  principals: z.array(z.string().max(CONTENT_LABEL_LIMITS.maxPrincipalLength)).max(CONTENT_LABEL_LIMITS.maxPrincipals),
  confidentiality: ConfidentialitySchema,
  refs: z.array(LabelRefSchema).max(CONTENT_LABEL_LIMITS.maxRefs),
});
export type ContentLabel = z.infer<typeof ContentLabelSchema>;

/** A label frozen all the way down, so a caller's `push` throws instead of changing a shared constant. */
function frozenLabel(label: ContentLabel): ContentLabel {
  return Object.freeze({
    ...label,
    sources: Object.freeze([...label.sources]),
    principals: Object.freeze([...label.principals]),
    refs: Object.freeze(label.refs.map((ref) => Object.freeze({ ...ref }))),
  }) as ContentLabel;
}

/** The join's identity: trusted, public, from nowhere. */
export const TRUSTED_PUBLIC: ContentLabel = frozenLabel({
  integrity: "trusted",
  sources: [],
  principals: [],
  confidentiality: "public",
  refs: [],
});

/** Untrusted from a source not named: a bare taint flag, or a label that does not parse — it only ever narrows. */
export const UNTRUSTED_UNKNOWN_SOURCE: ContentLabel = frozenLabel({
  integrity: "untrusted",
  sources: ["unknown-source"],
  principals: [],
  confidentiality: "public",
  refs: [],
});

const SOURCE_ORDER: ReadonlyMap<SourceKind, number> = new Map(SourceKindSchema.options.map((source, index) => [source, index]));
const CONFIDENTIALITY_RANK: Readonly<Record<Confidentiality, number>> = { public: 0, personal: 1, secret: 2 };

/** The higher of two confidentialities (`secret > personal > public`). */
export function maxConfidentiality(a: Confidentiality, b: Confidentiality): Confidentiality {
  return CONFIDENTIALITY_RANK[a] >= CONFIDENTIALITY_RANK[b] ? a : b;
}

/** Code-point order (not UTF-16 code-unit order, which `<` uses). */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

function refKey(ref: LabelRef): string {
  return `${ref.source}:${ref.ref}`;
}

/** A ref with its keys in one fixed order, optional fields only when present. */
function canonicalRef(ref: LabelRef): LabelRef {
  return {
    source: ref.source,
    ref: ref.ref,
    ...(ref.host !== undefined ? { host: ref.host } : {}),
    ...(ref.title !== undefined ? { title: ref.title } : {}),
    at: ref.at,
  };
}

/** Instants first; equal instants written differently fall back to the text. */
function compareAt(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta < tb ? -1 : 1;
  return compareCodePoints(a, b);
}

/**
 * Of two refs with one key, the one a join keeps: the later `at`, then
 * a total tiebreak. Keeping the earlier duplicate would break associativity
 * under "keep the newest 32" (an old duplicate that one grouping truncates
 * away cannot demote the key's newer entry, while another grouping joins it
 * first and drops the key). Keeping the later one makes the kept entry the
 * key's highest-ranked, so top-32 of the union is associative.
 */
function preferRef(a: LabelRef, b: LabelRef): LabelRef {
  const byAt = compareAt(a.at, b.at);
  if (byAt !== 0) return byAt > 0 ? a : b;
  return compareCodePoints(JSON.stringify(a), JSON.stringify(b)) <= 0 ? a : b;
}

/**
 * The semilattice join of two labels: integrity min, confidentiality
 * max, sources union (enum order), principals union then the 16 smallest in
 * code-point order, refs union deduplicated by `source:ref` (later `at` kept;
 * see `preferRef`) then the 32 greatest by `(at, source:ref)`, newest first.
 */
export function joinLabels(a: ContentLabel, b: ContentLabel): ContentLabel {
  const sources = [...new Set([...a.sources, ...b.sources])].sort((x, y) => (SOURCE_ORDER.get(x) ?? 0) - (SOURCE_ORDER.get(y) ?? 0));
  const principals = [...new Set([...a.principals, ...b.principals])].sort(compareCodePoints).slice(0, CONTENT_LABEL_LIMITS.maxPrincipals);
  const byKey = new Map<string, LabelRef>();
  for (const raw of [...a.refs, ...b.refs]) {
    const ref = canonicalRef(raw);
    const key = refKey(ref);
    const held = byKey.get(key);
    byKey.set(key, held === undefined ? ref : preferRef(held, ref));
  }
  const refs = [...byKey.values()]
    .sort((x, y) => compareAt(y.at, x.at) || compareCodePoints(refKey(y), refKey(x)))
    .slice(0, CONTENT_LABEL_LIMITS.maxRefs);
  return {
    integrity: a.integrity === "untrusted" || b.integrity === "untrusted" ? "untrusted" : "trusted",
    sources,
    principals,
    confidentiality: maxConfidentiality(a.confidentiality, b.confidentiality),
    refs,
  };
}

/** The canonical form of one label (its join with the identity). */
export function normalizeLabel(label: ContentLabel): ContentLabel {
  return joinLabels(label, TRUSTED_PUBLIC);
}

/** The label of content from an untrusted source. */
export function untrustedLabel(
  source: SourceKind,
  options: {
    principal?: string;
    ref?: Omit<LabelRef, "source">;
    confidentiality?: Confidentiality;
  } = {},
): ContentLabel {
  return normalizeLabel({
    integrity: "untrusted",
    sources: [source],
    principals: options.principal !== undefined ? [options.principal] : [],
    confidentiality: options.confidentiality ?? "public",
    refs: options.ref !== undefined ? [{ ...options.ref, source }] : [],
  });
}

/** The label of trusted content that is still confidential (memory, host-folder files). */
export function trustedLabel(confidentiality: Confidentiality): ContentLabel {
  return { integrity: "trusted", sources: [], principals: [], confidentiality, refs: [] };
}

/** [A]: the text may not steer actions. */
export function isUntrusted(label: ContentLabel): boolean {
  return label.integrity === "untrusted";
}

/** Whether a label says nothing: trusted, public, from nowhere (the join's identity). */
export function isTrustedPublic(label: ContentLabel): boolean {
  return (
    label.integrity === "trusted" &&
    label.confidentiality === "public" &&
    label.sources.length === 0 &&
    label.principals.length === 0 &&
    label.refs.length === 0
  );
}

/** [B]: something would leak if it went out. */
export function isPrivate(label: ContentLabel): boolean {
  return label.confidentiality !== "public";
}

/** What a verdict says about the context's label (`GateVerdict.risk.label`). */
export const LabelSummarySchema = z.strictObject({
  integrity: IntegritySchema,
  sources: z.array(SourceKindSchema).max(CONTENT_LABEL_LIMITS.maxSources),
  principals: z.array(z.string().max(CONTENT_LABEL_LIMITS.maxPrincipalLength)).max(CONTENT_LABEL_LIMITS.maxPrincipals),
  confidentiality: ConfidentialitySchema,
  refs: z.array(LabelRefSchema).max(CONTENT_LABEL_LIMITS.summaryRefs),
  /** Set when display detail was dropped to fit the byte bound. */
  truncated: z.literal(true).optional(),
});
export type LabelSummary = z.infer<typeof LabelSummarySchema>;

/** UTF-8 byte length of a string (contracts compile without `TextEncoder`). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** UTF-8 bytes of a summary's JSON, as stored. */
export function labelSummaryBytes(summary: LabelSummary): number {
  return utf8Bytes(JSON.stringify(summary));
}

/**
 * A verdict's label summary: integrity, sources, principals, confidentiality
 * and the newest `maxRefs` refs, its JSON bounded to
 * `CONTENT_LABEL_LIMITS.summaryMaxBytes` (4 KiB) of UTF-8. `maxRefs` must be an
 * integer from 0 to `CONTENT_LABEL_LIMITS.summaryRefs`; any other value throws
 * a `RangeError`. Over the byte bound, display detail goes first (ref titles,
 * then refs from the oldest, then principals from the greatest) and
 * `truncated` is set; integrity, confidentiality and sources are always kept
 * (all 15 sources fit well within the bound).
 */
export function labelSummary(label: ContentLabel, maxRefs: number = CONTENT_LABEL_LIMITS.summaryRefs): LabelSummary {
  if (!Number.isInteger(maxRefs) || maxRefs < 0 || maxRefs > CONTENT_LABEL_LIMITS.summaryRefs) {
    throw new RangeError(`maxRefs must be an integer from 0 to ${CONTENT_LABEL_LIMITS.summaryRefs}`);
  }
  const canonical = normalizeLabel(label);
  let refs = canonical.refs.slice(0, maxRefs);
  let principals = canonical.principals;
  let truncated = false;
  const build = (): LabelSummary => ({
    integrity: canonical.integrity,
    sources: canonical.sources,
    principals,
    confidentiality: canonical.confidentiality,
    refs,
    ...(truncated ? { truncated: true as const } : {}),
  });
  const fits = (): boolean => labelSummaryBytes(build()) <= CONTENT_LABEL_LIMITS.summaryMaxBytes;
  if (fits()) return build();
  truncated = true;
  if (refs.some((ref) => ref.title !== undefined)) {
    refs = refs.map(({ title: _title, ...rest }) => rest);
    if (fits()) return build();
  }
  while (refs.length > 0 && !fits()) refs = refs.slice(0, -1);
  if (fits()) return build();
  while (principals.length > 0 && !fits()) principals = principals.slice(0, -1);
  return build();
}
