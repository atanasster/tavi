/**
 * Secret/credential exclusion: a fixed field-name denylist (`apiKey`,
 * `token`, `password`, `secret`, `credential`, `authorization`,
 * case-insensitive substring match) for `key: value` pairs in free text, plus
 * credential shapes anywhere in text or a tool's structured output. Pure and platform-neutral (no Node/runtime
 * imports), so every package applies it identically.
 */
export const SECRET_FIELD_DENYLIST: readonly string[] = ["apikey", "token", "password", "secret", "credential", "authorization"];

const REDACTED = "[redacted]";

/**
 * Redacts any denylisted key/value pair embedded in free text (a
 * captured summary string, not a structured JSON value) — a best-effort
 * scan for `key: value` / `key=value` / `"key": "value"` shaped
 * substrings naming a denylisted field, since a captured task summary is
 * plain text.
 * Deliberately conservative: matches only ASCII word characters for the
 * key and stops the replaced value at the next whitespace/quote/comma/
 * brace, so it cannot itself become a new injection vector by eating
 * unrelated text.
 *
 * The key's own prefix/suffix is bounded (`\w{0,40}`, not unbounded
 * `\w*`) — an unbounded quantifier on both sides of an alternation is
 * quadratic-time on long delimiter-free runs of word characters
 * (measured: ~250,000 such characters took ~5s), a real DoS vector
 * against text this function is meant to run on tool-influenced,
 * size-uncontrolled captured output. 40 characters is generous for any
 * real field name and turns the worst case linear in the input length.
 *
 * A quoted pair's OUTPUT is not guaranteed to be valid JSON even when
 * the input was — e.g. `{"password": "x"}` becomes `{"password:
 * [redacted]}` (the leading quote is preserved, the trailing one is
 * consumed as part of the matched value) — this function only promises
 * the secret text is gone, never that surrounding punctuation round-trips.
 *
 * Also tolerates a SINGLE escaping backslash before each quote
 * (`\\?"?`, and the value stops before a bare backslash too) — a
 * realistic shape:
 * a model relaying a tool's raw JSON error verbatim in its own final
 * text response, with quotes escaped as `\"key\":\"value\"` (e.g.
 * inside a markdown code fence or a nested JSON-in-text rendering).
 * Only one level of escaping is handled — doubly-escaped text
 * (`\\\"`) is not, consistent with this function's own "best-effort,
 * deliberately conservative" framing rather than a general JSON/string
 * unescaper.
 */
/**
 * Redact credential *shapes* anywhere in free text.
 *
 * `redactSecretsInText` needs a denylisted key name before a colon; provider error
 * bodies routinely carry the credential without one — an echoed
 * `{"headers":{"Authorization":"Bearer sk-live-…"}}` has the value but the
 * denylist only ever matches the key, so nothing would be removed. This is
 * the shape half: bearer tokens, the authorization header, the
 * well-known key prefixes and PEM private keys. Call `scrubCredentialText` unless
 * you specifically want only this half.
 *
 * Deliberately over-inclusive, for the same reason the key denylist is: a false
 * positive costs a readable diagnostic, a false negative writes a live credential
 * into durable storage, the terminal and the model's context.
 */
export function redactCredentialShapes(text: string): string {
  const prefixed = maskCredentialPrefixes(redactPemBlocks(text));
  // Then every full-length shape `redactToolText` knows (AWS keys, `github_pat_`, Stripe's
  // `sk_live_`, JWTs, `xapp-`, connection-string passwords…), so the two scrubbers never
  // drift apart. The short prefixes stay: they mask a key while it is still being
  // typed (`looksLikeCredential`), long before it reaches a full shape's length.
  return redactShapes(prefixed, () => REDACTED);
}

/**
 * The short-prefix half of `redactCredentialShapes` alone: bearer tokens, the
 * authorization header and the `sk-`, `ghp_`, `glpat`, `xox…` and `AIza`
 * prefixes, masked as `[redacted]` however short. Every full-length shape
 * `redactToolText` knows is left as written, so a later `redactToolOutput`
 * still labels and counts it (`[redacted:aws-key]`) — or leaves it, when a
 * workspace turns that redaction off — while a fragment too short for any full
 * shape is masked either way.
 */
export function redactCredentialPrefixes(text: string): string {
  const full: [number, number][] = [];
  for (const { pattern } of TOOL_OUTPUT_SHAPES) {
    for (const match of text.matchAll(pattern)) full.push([match.index, match.index + match[0].length]);
  }
  if (full.length === 0) return maskCredentialPrefixes(text);
  full.sort((left, right) => left[0] - right[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of full) {
    if (end <= cursor) continue;
    if (start > cursor) out += maskCredentialPrefixes(text.slice(cursor, start));
    out += text.slice(Math.max(start, cursor), end);
    cursor = end;
  }
  return out + maskCredentialPrefixes(text.slice(cursor));
}

/** The short credential prefixes `redactCredentialShapes` and `redactCredentialPrefixes` share. */
function maskCredentialPrefixes(text: string): string {
  return (
    text
      // The header shape, basic or bearer, quoted or bare: `{"Authorization":
      // "Bearer sk-live-…"}` is what an echoing endpoint actually returns, and the
      // key-name pass cannot parse the quoting around a value that contains a space.
      // `"?` closes a JSON key (`"authorization": "Basic …"`), which is the shape an
      // echoed request actually has.
      .replace(/\b(authorization)\b"?\s*[:=]\s*"?\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1: [redacted]")
      .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
      .replace(/\b(?:ghp|gho|ghs|glpat|xox[baprs])_?[A-Za-z0-9_-]{6,}/g, "[redacted]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
  );
}

/**
 * Redact PEM private keys without the quadratic rescan a lazy regex causes.
 *
 * `-----BEGIN …-----` + `[\s\S]*?` + `-----END …-----` is lazy, so every BEGIN
 * with no matching END makes the engine scan the entire remaining string:
 * O(markers x length). Measured on this file's own function, a 4 MiB body with
 * 135 000 unterminated markers took over 60 seconds — and both callers take
 * attacker-influenced input (an allowlisted but untrusted host's response body,
 * and a provider's own error message, which `@ai-sdk/openai` copies from the
 * response JSON with no size bound). `indexOf` is linear and an unterminated
 * marker simply matches nothing.
 */
function redactPemBlocks(text: string): string {
  const BEGIN = "-----BEGIN ";
  const END = "-----END ";
  let cursor = 0;
  let out = "";
  for (;;) {
    const begin = text.indexOf(BEGIN, cursor);
    if (begin === -1) return out + text.slice(cursor);
    const headerEnd = text.indexOf("-----", begin + BEGIN.length);
    const header = headerEnd === -1 ? "" : text.slice(begin + BEGIN.length, headerEnd);
    if (headerEnd === -1 || !header.endsWith("PRIVATE KEY")) {
      // Not a private-key block: keep the marker text and move past it, so a
      // document full of `-----BEGIN CERTIFICATE-----` costs one scan.
      out += text.slice(cursor, begin + BEGIN.length);
      cursor = begin + BEGIN.length;
      continue;
    }
    const end = text.indexOf(END, headerEnd + 5);
    const endHeaderEnd = end === -1 ? -1 : text.indexOf("-----", end + END.length);
    if (end === -1 || endHeaderEnd === -1) {
      // Unterminated: nothing to redact, and nothing more to look for.
      return out + text.slice(cursor);
    }
    out += text.slice(cursor, begin) + "[redacted private key]";
    cursor = endHeaderEnd + 5;
  }
}

/**
 * The whole scrubber, in the one order that works.
 *
 * Shape pass first: the key-name pass rewrites a quoted header value into
 * `authorization: [redacted] <rest>`, which hides the shape from the shape pass.
 * Exported so a caller cannot compose the two in the wrong order — with
 * `toModelError` running only the shape half, a key-named credential would
 * still reach the task row.
 */
export function scrubCredentialText(text: string): string {
  return redactKeySettingsLinks(redactSecretsInText(redactCredentialShapes(text)));
}

/**
 * A provider's link to one key's settings page (OpenRouter's
 * `…/keys/<64-hex id>` in its billing errors): not the secret, but it names
 * the key, and an error is shown in chats and pictures. The link is dropped.
 */
function redactKeySettingsLinks(text: string): string {
  return text.replace(/https?:\/\/\S*\/keys\/[0-9a-f]{16,}\S*/gi, "[the key's settings page]");
}

export function redactSecretsInText(text: string): string {
  const pattern = new RegExp(
    `\\b(\\w{0,40}(?:${SECRET_FIELD_DENYLIST.join("|")})\\w{0,40})\\\\?"?\\s*[:=]\\s*\\\\?"?(?:[^\\s",\\\\}]+)\\\\?"?`,
    "gi",
  );
  // The value pattern stops at the first space, so a *quoted* value with a space in
  // it (`"authorization": "Basic dXNl…"`) keeps its secret. That form is handled by
  // `redactCredentialShapes`, which matches the header shape directly rather than
  // trying to parse the quoting here — and which every production path runs after
  // this function.
  return text.replace(pattern, (_match, key: string) => `${key}: ${REDACTED}`);
}

/**
 * The kinds of credential `redactToolOutput` recognises, each written into the
 * text as `[redacted:<kind>]`.
 */
export const TOOL_OUTPUT_REDACTION_KINDS = [
  "private-key",
  "aws-key",
  "github-token",
  "gitlab-token",
  "slack-token",
  "stripe-key",
  "api-key",
  "google-key",
  "jwt",
  "bearer-token",
  "huggingface-token",
  "npm-token",
  "pypi-token",
  "sendgrid-key",
  "telegram-token",
  "connection-string",
] as const;
export type ToolOutputRedactionKind = (typeof TOOL_OUTPUT_REDACTION_KINDS)[number];

/** A placeholder `redactToolOutput` wrote; a writing tool's input holding one is refused. */
export const REDACTION_PLACEHOLDER_PATTERN = /\[redacted:[a-z-]{2,32}\]/;

/**
 * Shapes only, each anchored on its own delimiter, so ordinary prose and
 * identifiers pass: `ghostwriter`, `tokens: 512`, git SHAs, UUIDs and base64
 * are never matched. The key-name pass of `scrubCredentialText` is left out on
 * purpose — it rewrites `{"password": "x"}` into broken JSON and matches any
 * word containing `token`, which tool output (code, logs, config) is full of.
 */
const TOOL_OUTPUT_SHAPES: readonly { readonly kind: ToolOutputRedactionKind; readonly pattern: RegExp; readonly keep?: number }[] = [
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", pattern: /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/g },
  { kind: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "api-key", pattern: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // `Authorization: Bearer x` and a bare `Bearer x`: the scheme word is kept so the text still reads.
  {
    kind: "bearer-token",
    pattern: /\b((?:authorization)"?\s*[:=]\s*"?\s*(?:basic|bearer)\s+|bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
    keep: 1,
  },
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  { kind: "sendgrid-key", pattern: /\bSG\.[\w-]{16,}\.[\w-]{16,}/g },
  { kind: "telegram-token", pattern: /\b\d{8,10}:AA[\w-]{33}(?![\w-])/g },
  // The password in `scheme://user:password@host` (the user may be empty: `redis://:secret@host`),
  // `@host` kept. The authority ends at the first `/`, `?` or `#` (RFC 3986: a password holding one
  // must be percent-encoded), so a URL with a port and an `@` in its path
  // (`https://registry.npmjs.org:443/@tavi/contracts`) never matches. Within the authority the
  // password runs to its last `@` (`p@ssw0rd@db` masks `p@ssw0rd`); past its first `@` it never
  // takes a quote or angle bracket, so a JSON or HTML neighbour with an `@` of its own is not
  // swallowed. `@`-separated runs with a character class each, so matching stays linear. The scheme
  // is bounded: unbounded, every `.`/`-` boundary in a long dotted run would rescan to its end. A
  // placeholder password, the whole of it (`<password>`, `${DB_PASS}`, `$DB_PASS`, `****`, `xxx`,
  // `PASSWORD`), is a template, not a secret; `$ecretP4ss` is not an upper-case variable name.
  {
    kind: "connection-string",
    pattern:
      /\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^:/?#@\s]*:)(?!(?:<[^>@\s]*>|\$?\{[^}@\s]*\}|\$[A-Z_][A-Z0-9_]*|\*+|[xX]+|[Pp]assword|PASSWORD)@[^/?#@\s"'`<>]*(?:[/?#\s"'`<>]|$))[^/?#@\s]+(?:@[^/?#@\s"'`<>]*)*(?=@[^/?#@\s"'`<>]*(?:[/?#\s"'`<>]|$))/g,
    keep: 1,
  },
];

/** Every `TOOL_OUTPUT_SHAPES` match in `text` replaced by `placeholder(kind)`, a kept prefix group left in place. */
function redactShapes(text: string, placeholder: (kind: ToolOutputRedactionKind) => string): string {
  let out = text;
  for (const { kind, pattern, keep } of TOOL_OUTPUT_SHAPES) {
    out = out.replace(pattern, (...groups: unknown[]) => (keep === undefined ? "" : String(groups[keep])) + placeholder(kind));
  }
  return out;
}

/** One string with every credential shape masked, and the kinds it masked. */
export function redactToolText(text: string): { readonly text: string; readonly masked: readonly ToolOutputRedactionKind[] } {
  const masked: ToolOutputRedactionKind[] = [];
  let out = text;
  if (out.includes("-----BEGIN ")) {
    const pem = redactPemBlocks(out);
    for (let index = countOf(out, PEM_PLACEHOLDER); index < countOf(pem, PEM_PLACEHOLDER); index += 1) masked.push("private-key");
    out = pem.replaceAll(PEM_PLACEHOLDER, "[redacted:private-key]");
  }
  out = redactShapes(out, (kind) => {
    masked.push(kind);
    return `[redacted:${kind}]`;
  });
  return { text: out, masked };
}

const PEM_PLACEHOLDER = "[redacted private key]";

function countOf(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

const MAX_TOOL_OUTPUT_DEPTH = 64;

/**
 * A tool's structured output with every credential shape in its string leaves
 * masked. Keys, numbers and the shape are kept, so
 * JSON stays JSON. A subtree past `MAX_TOOL_OUTPUT_DEPTH` is replaced whole —
 * failing closed rather than passing it unscanned. `masked` counts each kind.
 */
export function redactToolOutput(value: unknown): {
  readonly value: unknown;
  readonly masked: Readonly<Partial<Record<ToolOutputRedactionKind, number>>>;
} {
  const masked: Partial<Record<ToolOutputRedactionKind, number>> = {};
  let cut = false;
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      const result = redactToolText(node);
      for (const kind of result.masked) masked[kind] = (masked[kind] ?? 0) + 1;
      return result.text;
    }
    if (node === null || typeof node !== "object") return node;
    if (depth >= MAX_TOOL_OUTPUT_DEPTH) {
      cut = true;
      return "[redacted:too-deep]";
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    // Null prototype, so a key named `__proto__` stays an own property, not a prototype write.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(node)) result[key] = walk(entry, depth + 1);
    return result;
  };
  const redacted = walk(value, 0);
  return { value: Object.keys(masked).length === 0 && !cut ? value : redacted, masked };
}

/** Whether any string leaf of `value` holds a placeholder `redactToolOutput` wrote. */
export function containsRedactionPlaceholder(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return REDACTION_PLACEHOLDER_PATTERN.test(value);
  if (value === null || typeof value !== "object" || depth >= MAX_TOOL_OUTPUT_DEPTH) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some((entry) => containsRedactionPlaceholder(entry, depth + 1));
}

/** "2 secrets masked (aws-key, github-token)": what a tool card says it hid, never the values. */
export function maskedSecretsNote(masked: Readonly<Partial<Record<ToolOutputRedactionKind, number>>> | undefined): string | undefined {
  if (masked === undefined) return undefined;
  const kinds = TOOL_OUTPUT_REDACTION_KINDS.filter((kind) => (masked[kind] ?? 0) > 0);
  if (kinds.length === 0) return undefined;
  const total = kinds.reduce((sum, kind) => sum + (masked[kind] ?? 0), 0);
  return `${total} ${total === 1 ? "secret" : "secrets"} masked (${kinds.join(", ")}) — tools.redactResults`;
}

/**
 * Text a plugin wrote — a status line, a notice, a suggestion, a hook's
 * reason — masked as a tool's output is and by key name too (`password=x`),
 * then cut to `max` so masking can never push it past its bound.
 */
export function maskPluginText(text: string, max = Number.POSITIVE_INFINITY): string {
  return scrubCredentialText(redactToolText(text).text).slice(0, max);
}
