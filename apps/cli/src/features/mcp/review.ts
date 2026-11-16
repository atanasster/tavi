import type { Tool } from "@modelcontextprotocol/client";
import {
  MCP_SEARCH_LINE_MAX,
  MCP_TOOL_TIMEOUT_MS,
  TaviError,
  comparePluginVersions,
  maxRisk,
  type McpArgFloor,
  type McpToolDecision,
  type McpToolDefinition,
  type McpToolRecord,
  type RiskLevel,
  type ToolEffect,
} from "@tavi/contracts";
import { definedOnly, isRecord } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { injectionPatternSignals } from "@tavi/runtime";

import { canonicalHash } from "./jcs.js";
import { cleanServerText, cleanStructured } from "./results.js";

/**
 * Turning a server's tool list into what the operator reviews:
 * the pinned definition and its hash,
 * Tavi's tool id, the effect suggested from spec-defaulted annotations, the
 * marks that block bulk approval, and the operator's decisions.
 */

/** The `_meta` key a video analyser's manifest is declared under. */
const ANALYZER_META_KEY = "tavi/analyzer";

/**
 * The hashed parts of a definition: `_meta` and anything else the server adds are left out, but for a video
 * analyser's manifest (`_meta["tavi/analyzer"]`), which is pinned with the rest so changing it is drift.
 */
export function definitionOf(tool: Tool): McpToolDefinition {
  const raw = tool as Tool & {
    readonly title?: unknown;
    readonly outputSchema?: unknown;
    readonly annotations?: unknown;
    readonly _meta?: unknown;
  };
  const meta = raw._meta;
  const analyzer = isRecord(meta) ? meta[ANALYZER_META_KEY] : undefined;
  return {
    name: raw.name,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    inputSchema: raw.inputSchema,
    ...definedOnly({
      outputSchema: raw.outputSchema,
      annotations: raw.annotations,
      analyzer,
    }),
  };
}

/** SHA-256 of the definition's RFC 8785 canonical JSON: key order never drifts. */
export function definitionHash(definition: McpToolDefinition): string {
  return canonicalHash(definition);
}

const shortHash = (text: string): string => sha256Hex(text).slice(0, 6);

/**
 * `mcp.<slug>.<name>` with the name normalized: lowercase;
 * runs outside `[a-z0-9_]` become `_`; `_` trimmed; `t_` before a name that
 * does not start with a letter; at most `64 − 5 − len(slug)` characters, a
 * longer one cut and given 6 hex of its hash. A collision with `taken` (the
 * server's other tools and every registered id) is resolved with a hash
 * suffix too, never by refusing the server.
 */
export function toolIdFor(slug: string, name: string, taken: ReadonlySet<string>): string {
  const budget = 64 - 5 - slug.length;
  let normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(normalized)) normalized = `t_${normalized}`.replace(/_+$/, "");
  if (normalized === "t") normalized = `t_${shortHash(name)}`;
  if (normalized.length > budget) normalized = `${normalized.slice(0, budget - 7).replace(/_+$/, "")}_${shortHash(name)}`;
  let id = `mcp.${slug}.${normalized}`;
  for (let attempt = 0; taken.has(id); attempt += 1) {
    const suffix = shortHash(`${name}\u0000${String(attempt)}`);
    id = `mcp.${slug}.${normalized.slice(0, budget - 7).replace(/_+$/, "")}_${suffix}`;
  }
  return id;
}

/**
 * Whether a tool's id carries a collision suffix: it is not the id its name alone would give (the 6 hex
 * `toolIdFor` adds when another tool took that id). Its name then no longer reads in its id, so the model is told
 * the server's name in its description (`[Original MCP tool: <name>]`).
 */
export function collisionSuffixed(slug: string, name: string, toolId: string): boolean {
  return toolId !== toolIdFor(slug, name, new Set());
}

interface Hints {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly openWorld: boolean;
}

/** The annotations with the spec's defaults filled: an unannotated tool is a destructive, open-world write. */
export function normalizedHints(annotations: unknown): Hints {
  const given = (annotations ?? {}) as {
    readonly readOnlyHint?: unknown;
    readonly destructiveHint?: unknown;
    readonly openWorldHint?: unknown;
  };
  return {
    readOnly: given.readOnlyHint === true,
    destructive: given.destructiveHint !== false,
    openWorld: given.openWorldHint !== false,
  };
}

/** The suggested effect and floor: read-only wins; otherwise destructive means a `high` floor. */
export function suggestEffect(annotations: unknown): { readonly effect: ToolEffect; readonly minRisk?: RiskLevel } {
  const hints = normalizedHints(annotations);
  if (hints.readOnly) return { effect: "read-only" };
  const effect: ToolEffect = hints.openWorld ? "external" : "mutating";
  return hints.destructive ? { effect, minRisk: "high" } : { effect };
}

const WRITE_SEGMENTS = new Set([
  "create",
  "update",
  "set",
  "send",
  "post",
  "put",
  "delete",
  "remove",
  "clear",
  "save",
  "write",
  "move",
  "rename",
  "archive",
  "cancel",
  "run",
  "exec",
  "execute",
]);

/** A name with a write segment (`create_event`, `turnOn`, `browser_console_clear`). */
export function writeNamed(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (segments.some((segment) => WRITE_SEGMENTS.has(segment))) return true;
  const joined = segments.join("_");
  return joined.includes("turn_on") || joined.includes("turn_off");
}

/**
 * The published MCP tool-poisoning shapes (Invariant Labs' `<IMPORTANT>` payload and its variants): a pseudo-tag
 * addressing the model, a precondition to read or send something before the tool is used, a request to keep quiet,
 * a threat that the tool fails otherwise, and the paths of well-known secrets. A description's and a schema's alike.
 */
const POISONING_PHRASES = [
  /<\/?\s*(?:important|system|instructions?|hidden|secret|admin|critical)\s*>/i,
  /\b(?:before|prior to) (?:using|calling|invoking|running) this tool\b[^\n]{0,80}?\b(?:read|pass|send|include|provide|attach|upload|cat)\b/i,
  /\b(?:do not|don't|never) (?:mention|reveal|disclose)\b/i,
  /\botherwise the tool (?:will not|won't|does not|doesn't) work\b/i,
  /~\/\.ssh\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials\b|\/etc\/(?:passwd|shadow)\b|\.netrc\b/i,
];

const INSTRUCTION_PHRASES = [
  ...POISONING_PHRASES,
  /\bignore\b/i,
  /\balways call\b/i,
  /\bbefore (?:any|every) other tool\b/i,
  /\bdo not tell\b/i,
  /\bdon't tell\b/i,
  /https?:\/\//i,
];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A description that reads like instructions: flagged, never pre-selected. */
export function instructionLike(description: string | undefined, otherNames: readonly string[]): boolean {
  if (description === undefined || description === "") return false;
  if (INSTRUCTION_PHRASES.some((phrase) => phrase.test(description))) return true;
  // The untrusted-content detector's patterns too: forged chat-template tokens, fences, "prior instructions".
  if (injectionPatternSignals(description).length > 0) return true;
  return otherNames.some((name) => name.length >= 4 && new RegExp(`\\b${escaped(name)}\\b`).test(description));
}

/**
 * The phrases that read as instructions in a schema's prose. Narrower than a description's: a parameter's words
 * name URLs (`e.g. https://…`), sibling tools (`the id list_issues returns`) and `ignore` (`patterns to ignore`) as
 * a matter of course, so those mark a description only.
 */
const SCHEMA_INSTRUCTION_PHRASES = [
  ...POISONING_PHRASES,
  /\balways call\b/i,
  /\bbefore (?:any|every) other tool\b/i,
  /\bdo not tell\b/i,
  /\bdon't tell\b/i,
];

/** A schema prose string that reads like instructions: those phrases, or the untrusted-content detector's patterns. */
function schemaProseInstructionLike(text: string): boolean {
  return SCHEMA_INSTRUCTION_PHRASES.some((phrase) => phrase.test(text)) || injectionPatternSignals(text).length > 0;
}

/** Characters of a schema's prose (a `description`, `title`, `$comment`, example or unknown keyword's string) the model is shown; longer is cut. */
export const SCHEMA_PROSE_MAX = 300;

/** Prose a person or the model reads: every string under it is a server's words, never structure. */
const PROSE_KEYS = new Set(["description", "title", "$comment", "examples", "example", "default"]);
/** Keys whose values name subschemas: their keys are names (a property's), never keywords. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"]);
/** Keys whose values are a subschema, or a list of them. */
const SCHEMA_SUBSCHEMAS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "if",
  "then",
  "else",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "contentSchema",
]);
/** Structure and data: never prose, never a subschema. */
const SCHEMA_DATA = new Set([
  "$schema",
  "$id",
  "id",
  "$ref",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$vocabulary",
  "type",
  "format",
  "pattern",
  "const",
  "enum",
  "required",
  "dependentRequired",
  "contentMediaType",
  "contentEncoding",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "readOnly",
  "writeOnly",
  "deprecated",
  // OpenAPI's.
  "nullable",
  "discriminator",
  "xml",
]);

/**
 * What a schema keyword holds: prose, structure, a map of named subschemas, a subschema, or — a keyword outside the
 * JSON Schema vocabulary (`x-hint`, `markdownDescription`, `enumDescriptions`) — the server's own words. A validator
 * ignores an unknown keyword, but the model is shown it, so every string under it is prose.
 */
function keywordKind(key: string, value: unknown): "prose" | "data" | "map" | "subschema" | "unknown" {
  if (PROSE_KEYS.has(key)) return "prose";
  if (SCHEMA_DATA.has(key)) return "data";
  if (SCHEMA_MAPS.has(key)) return isRecord(value) ? "map" : "subschema";
  return SCHEMA_SUBSCHEMAS.has(key) ? "subschema" : "unknown";
}

/** A JSON pointer segment (RFC 6901). */
const pointerSegment = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Each string of a value, at its pointer: an example or an unknown keyword's value is words the model reads, at any depth. */
function mapExample(
  value: unknown,
  pointer: string,
  field: string,
  map: (text: string, pointer: string, field: string) => string,
  depth: number,
): unknown {
  if (typeof value === "string") return map(value, pointer, field);
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item, index) => mapExample(item, `${pointer}/${String(index)}`, field, map, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapExample(item, `${pointer}/${pointerSegment(key)}`, field, map, depth + 1)]),
  );
}

/**
 * A schema with each prose string replaced by `map(text, pointer, field)`: `description`, `title`, `$comment`, every
 * string of `examples` (and OpenAPI's `example`), a string `default`, and every string under a keyword outside the
 * vocabulary, at any depth. Structural strings (`$schema`, `$id`, `$ref`, `pattern`, `format`, `type`, `const`,
 * `enum`, property names) are never prose: a URL in `$schema` or a long `pattern` is not the server talking to the model.
 */
function mapSchemaProse(node: unknown, pointer: string, map: (text: string, pointer: string, field: string) => string, depth = 0): unknown {
  if (depth > 64 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item, index) => mapSchemaProse(item, `${pointer}/${String(index)}`, map, depth + 1));
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      const at = `${pointer}/${pointerSegment(key)}`;
      switch (keywordKind(key, value)) {
        case "prose":
          if (key === "examples" || key === "example") return [key, mapExample(value, at, "examples", map, depth + 1)];
          // A default that is not a string is data the call may carry, never prose.
          return [key, typeof value === "string" ? map(value, at, key) : value];
        case "unknown":
          return [key, mapExample(value, at, key, map, depth + 1)];
        case "data":
          return [key, value];
        case "map":
          return [
            key,
            Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([name, child]) => [
                name,
                mapSchemaProse(child, `${at}/${pointerSegment(name)}`, map, depth + 2),
              ]),
            ),
          ];
        case "subschema":
          return [key, mapSchemaProse(value, at, map, depth + 1)];
      }
    }),
  );
}

/**
 * A schema as the model and a person are shown it: every string cleaned (`cleanStructured`: no controls, no format
 * characters, forged fences quoted), and each prose string but a `default` cut at `SCHEMA_PROSE_MAX` characters. A
 * default is left whole: a validator fills it in, so it is what a call may send.
 */
export function cleanSchema(schema: unknown): unknown {
  return mapSchemaProse(cleanStructured(schema), "", (text, _pointer, field) =>
    field !== "default" && text.length > SCHEMA_PROSE_MAX ? `${text.slice(0, SCHEMA_PROSE_MAX - 1)}…` : text,
  );
}

/**
 * A definition as it reaches the model or a person: its title and description cleaned, its input and output schemas
 * cleaned with `cleanSchema`. The hash stays the raw definition's (`definitionHash`), so cleaning never reads as drift.
 */
export function cleanDefinition(definition: McpToolDefinition): McpToolDefinition {
  return {
    ...definition,
    ...(definition.title === undefined ? {} : { title: cleanServerText(definition.title) }),
    ...(definition.description === undefined ? {} : { description: cleanServerText(definition.description) }),
    inputSchema: cleanSchema(definition.inputSchema) as McpToolDefinition["inputSchema"],
    ...(definition.outputSchema === undefined ? {} : { outputSchema: cleanSchema(definition.outputSchema) }),
  };
}

/** Each prose string of a schema, cleaned, at its JSON pointer under `base`. */
export function schemaProse(schema: unknown, base: string): readonly { readonly pointer: string; readonly text: string }[] {
  const found: { pointer: string; text: string }[] = [];
  mapSchemaProse(schema, base, (text, pointer) => {
    found.push({ pointer, text: cleanServerText(text) });
    return text;
  });
  return found;
}

/**
 * Where a definition reads like instructions, as JSON pointers: `/description` and `/title` by `instructionLike`,
 * and its input and output schemas by `schemaFlags` (`/inputSchema/properties/to/description`). Empty for a clean one.
 */
export function definitionFlags(definition: McpToolDefinition, otherNames: readonly string[]): readonly string[] {
  const flags: string[] = [];
  if (instructionLike(definition.description === undefined ? undefined : cleanServerText(definition.description), otherNames))
    flags.push("/description");
  if (instructionLike(definition.title === undefined ? undefined : cleanServerText(definition.title), otherNames)) flags.push("/title");
  return [...flags, ...schemaFlags(definition.inputSchema, "/inputSchema"), ...schemaFlags(definition.outputSchema, "/outputSchema")];
}

/**
 * Where a schema reads like instructions, as JSON pointers under `base`: its prose by the schema phrases, and its
 * data the model reads too (property names, `enum` and `const` values, the strings of a default that is not a
 * string) by the poisoning shapes alone. An MCP tool's, or a plugin tool's (`tavi plugins validate`, and the log when
 * one loads). Empty for a clean one.
 */
export function schemaFlags(schema: unknown, base: string): readonly string[] {
  return [
    ...new Set(
      [
        ...schemaProse(schema, base)
          .filter((prose) => schemaProseInstructionLike(prose.text))
          .map((prose) => prose.pointer),
        ...schemaData(schema, base)
          .filter((data) => dataPoisoned(cleanServerText(data.text)))
          .map((data) => data.pointer),
        ...structuralChanges(schema, base),
      ]
        // A pointer holds the server's property names: cleaned, on one line and cut, as any server text shown.
        .map((pointer) => cleanServerText(pointer).replace(/\s+/g, " ").slice(0, 160)),
    ),
  ];
}

/**
 * A data string carrying a poisoning shape or the untrusted-content detector's patterns. Never the URL, sibling-name
 * or `always call` phrases: an enum value or a property name says those as a matter of course.
 */
const dataPoisoned = (text: string): boolean =>
  POISONING_PHRASES.some((phrase) => phrase.test(text)) || injectionPatternSignals(text).length > 0;

/** Each string and object key of a value, at its pointer, at any depth. */
function valueStrings(value: unknown, pointer: string, depth: number): readonly { readonly pointer: string; readonly text: string }[] {
  if (typeof value === "string") return [{ pointer, text: value }];
  if (depth > 64 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => valueStrings(item, `${pointer}/${String(index)}`, depth + 1));
  return Object.entries(value).flatMap(([key, item]) => {
    const at = `${pointer}/${pointerSegment(key)}`;
    return [{ pointer: at, text: key }, ...valueStrings(item, at, depth + 1)];
  });
}

/**
 * The strings of a schema the model reads that are not its prose, at their JSON pointers: each property (or other
 * named subschema's) name, every string of an `enum` or `const`, and every string and key of a default, an example
 * or an unknown keyword's value. Never cut, since a call may carry them, so a poisoned one can only be flagged.
 */
function schemaData(node: unknown, pointer: string, depth = 0): readonly { readonly pointer: string; readonly text: string }[] {
  if (depth > 64 || node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => schemaData(item, `${pointer}/${String(index)}`, depth + 1));
  return Object.entries(node).flatMap(([key, value]) => {
    const at = `${pointer}/${pointerSegment(key)}`;
    switch (keywordKind(key, value)) {
      case "map":
        return Object.entries(value as Record<string, unknown>).flatMap(([name, child]) => {
          const named = `${at}/${pointerSegment(name)}`;
          return [{ pointer: named, text: name }, ...schemaData(child, named, depth + 2)];
        });
      case "subschema":
        return schemaData(value, at, depth + 1);
      case "data":
        return key === "enum" || key === "const" ? valueStrings(value, at, depth + 1) : [];
      case "prose":
      case "unknown":
        // A string default or a string example is prose, flagged as such; what is under a structured one is data.
        return typeof value === "string" ? [] : valueStrings(value, at, depth + 1);
    }
  });
}

/** A string cleaning changes: it holds controls, format characters (zero-width, bidi, tags) or a forged fence. */
const hidesCharacters = (text: string): boolean => cleanServerText(text) !== text;

/**
 * Where cleaning changes a schema's structure, as JSON pointers under `base`: a property name or keyword, an `enum`
 * or `const` value, any string outside its prose. The model and the validator are given the cleaned one, so a call
 * carries a value the server, which expects the raw one, may refuse; and hidden characters in structure are a mark.
 */
function structuralChanges(node: unknown, pointer: string, depth = 0): readonly string[] {
  if (typeof node === "string") return hidesCharacters(node) ? [pointer] : [];
  if (depth > 64 || node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => structuralChanges(item, `${pointer}/${String(index)}`, depth + 1));
  return Object.entries(node).flatMap(([key, value]) => {
    const at = `${pointer}/${pointerSegment(key)}`;
    const kind = keywordKind(key, value);
    if (kind === "prose") return [];
    const ownKey = hidesCharacters(key) ? [at] : [];
    // An unknown keyword's value is prose: cleaning it changes nothing a call carries.
    if (kind === "unknown") return ownKey;
    if (kind === "map")
      return [
        ...ownKey,
        ...Object.entries(value as Record<string, unknown>).flatMap(([name, child]) => {
          const named = `${at}/${pointerSegment(name)}`;
          return [...(hidesCharacters(name) ? [named] : []), ...structuralChanges(child, named, depth + 2)];
        }),
      ];
    return [...ownKey, ...structuralChanges(value, at, depth + 1)];
  });
}

/**
 * Tavi's built-in tool families an MCP server can duplicate: which registered ids are the family, and the words in a
 * server's name or its tools' names that say it does the same job. A Gmail server beside a connected mailbox gives
 * the model two ways to send mail, and the one it picks may not be the one the operator approved for that.
 */
const BUILT_IN_FAMILIES: readonly {
  readonly label: string;
  /** The family's ids among the registered (none of them an MCP server's). */
  readonly members: (toolIds: readonly string[]) => readonly string[];
  readonly words: ReadonlySet<string>;
}[] = [
  {
    label: "mail",
    // A mailbox account's four tools, `<provider>.<account>.search|read|draft|send_draft`, known by its send_draft.
    members: (ids) => {
      const accounts = new Set(
        ids.filter((id) => /^[a-z0-9_-]+\.[a-z0-9_]+\.send_draft$/.test(id)).map((id) => id.slice(0, -"send_draft".length)),
      );
      return ids.filter((id) => id.startsWith("mail.") || [...accounts].some((account) => id.startsWith(account)));
    },
    words: new Set(["gmail", "mail", "email", "emails", "inbox", "outlook", "imap", "smtp", "mailbox", "jmap"]),
  },
  {
    label: "browser",
    members: (ids) => ids.filter((id) => id.startsWith("browser.")),
    words: new Set(["browser", "playwright", "puppeteer", "chrome", "chromium", "selenium", "webdriver"]),
  },
  {
    label: "file",
    members: (ids) => ids.filter((id) => id.startsWith("fs.")),
    words: new Set(["filesystem", "file", "files", "directory", "directories", "folder", "folders"]),
  },
  {
    label: "web",
    members: (ids) => ids.filter((id) => id === "web_search" || id === "web_fetch"),
    words: new Set(["fetch", "scrape", "crawl", "brave", "tavily", "exa", "serp", "websearch"]),
  },
  {
    label: "sandbox",
    members: (ids) => ids.filter((id) => id.startsWith("sandbox.")),
    words: new Set(["shell", "bash", "terminal", "exec", "execute", "command", "commands"]),
  },
  {
    label: "memory",
    members: (ids) => ids.filter((id) => id.startsWith("memory.")),
    words: new Set(["memory", "memories", "remember", "knowledge"]),
  },
  {
    label: "schedule and reminder",
    members: (ids) => ids.filter((id) => id.startsWith("schedules.") || id.startsWith("reminders.")),
    words: new Set(["schedule", "schedules", "cron", "reminder", "reminders", "remind"]),
  },
  {
    label: "desktop",
    members: (ids) => ids.filter((id) => id.startsWith("desktop.")),
    words: new Set(["desktop", "screenshot", "mouse", "keyboard", "computer"]),
  },
  {
    label: "messaging",
    members: (ids) => ids.filter((id) => id.startsWith("messaging.")),
    words: new Set(["slack", "telegram", "discord", "whatsapp", "signal", "sms", "imessage"]),
  },
];

/** A name's words: `sendEmail` and `send-email` both give `send`, `email`. */
function nameWords(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Up to `count` entries, then `, …`. */
const someOf = (items: readonly string[], count: number): string =>
  items.length <= count ? items.join(", ") : `${items.slice(0, count).join(", ")}, …`;

/**
 * How an overlap warning ends: what to do about it is each surface's own (`--disable` in the terminal, Leave out on
 * the canvas), so the warning names none.
 */
export const OVERLAP = "the model may pick either";

/**
 * What the operator is warned of before approving a server: tools that overlap a built-in family (the model may
 * pick either), and descriptions or schema prose that name another tool — a built-in's id, another server's, or a distinctive
 * built-in name such as `web_search` or `send_draft` — which can steer the model toward or away from it (shadowing).
 * Warnings only: approval is never refused for them. Every name shown is Tavi's id or cleaned server text.
 */
export function shadowingWarnings(input: {
  readonly serverName: string;
  readonly slug: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    /** Its schemas' prose (`schemaProse`), which the model reads too. */
    readonly prose?: readonly string[];
  }[];
  /** Every registered tool id: built-ins, connected accounts', plugins' and other servers'. */
  readonly registered: ReadonlySet<string>;
}): readonly string[] {
  const own = `mcp.${input.slug}.`;
  const others = [...input.registered].filter((id) => !id.startsWith(own)).sort();
  const warnings: string[] = [];
  const serverWords = new Set([...nameWords(input.serverName), ...nameWords(input.slug)]);
  for (const family of BUILT_IN_FAMILIES) {
    const members = family.members(others.filter((id) => !id.startsWith("mcp.")));
    if (members.length === 0) continue;
    const byServer = [...serverWords].some((word) => family.words.has(word));
    const overlapping = input.tools.filter((tool) => nameWords(tool.name).some((word) => family.words.has(word))).map((tool) => tool.name);
    if (!byServer && overlapping.length === 0) continue;
    const which =
      overlapping.length === 0
        ? "its tools"
        : someOf(
            overlapping.map((name) => cleanServerText(name).slice(0, 64)),
            5,
          );
    warnings.push(
      `${which} ${overlapping.length === 1 ? "overlaps" : "overlap"} Tavi's built-in ${family.label} tools (${someOf(members, 3)}): ${OVERLAP}`,
    );
  }
  // Names distinctive enough to mean a tool when a description says them: whole ids, and built-in names with a `_`.
  const ownNames = new Set(input.tools.map((tool) => tool.name));
  const tails = new Set(
    others
      .filter((id) => !id.startsWith("mcp."))
      .map((id) => id.split(".").at(-1) ?? id)
      .filter((tail) => tail.includes("_") && tail.length >= 8 && !ownNames.has(tail)),
  );
  const names = [...new Set([...others, ...tails])];
  const naming = (text: string): readonly string[] =>
    text === "" ? [] : names.filter((name) => new RegExp(`(?<![\\w.])${escaped(name)}(?![\\w])`).test(text));
  for (const tool of input.tools) {
    const inDescription = naming(cleanServerText(tool.description ?? ""));
    const inSchema = naming(cleanServerText((tool.prose ?? []).join("\n"))).filter((name) => !inDescription.includes(name));
    const where = [...(inDescription.length === 0 ? [] : ["description"]), ...(inSchema.length === 0 ? [] : ["schema"])].join(" and ");
    if (where === "") continue;
    warnings.push(
      `${cleanServerText(tool.name).slice(0, 64)}'s ${where} ${where.includes(" and ") ? "name" : "names"} other tools (${someOf([...inDescription, ...inSchema], 5)}): it may steer the model toward or away from them (shadowing)`,
    );
  }
  return warnings;
}

/**
 * The tokens a tool's offer costs the model: its name,
 * description and input schema as JSON, at about four characters a token.
 * The review and `doctor` both count with it.
 */
export function schemaTokenCount(offer: { readonly name: string; readonly description: string; readonly parameters: unknown }): number {
  return Math.ceil(JSON.stringify(offer).length / 4);
}

/** An approved definition's offer, counted with `schemaTokenCount` over its cleaned schema (what the model is sent). */
export function schemaTokens(definition: McpToolDefinition): number {
  return schemaTokenCount({
    name: definition.name,
    description: definition.description ?? definition.title ?? "",
    parameters: cleanSchema(definition.inputSchema),
  });
}

/**
 * Tavi's own line for a server in `tools.search`'s description, until
 * the operator writes one: the server's name as the operator gave it, how
 * many tools it has, and their Tavi names — never the server's own text.
 */
export function defaultSearchLine(serverName: string, toolIds: readonly string[]): string {
  const names = toolIds.map((id) => id.split(".").slice(2).join("."));
  const room = MCP_SEARCH_LINE_MAX - serverName.length - 20;
  let shown = names.join(", ");
  for (let count = names.length; count > 1 && shown.length > room; ) {
    count -= 1;
    shown = `${names.slice(0, count).join(", ")}, …`;
  }
  return `${serverName}: ${String(names.length)} ${names.length === 1 ? "tool" : "tools"} (${shown})`;
}

/** A reviewed tool as the store records it, before any decision. */
export type ObservedTool = Omit<McpToolRecord, "state" | "decision" | "approvedDef" | "approvedDefHash" | "reviewedBy" | "reviewedAt">;

/** Every listed tool, with its id, hash, suggestion and marks; ids avoid `registered` and each other. */
export function observeTools(
  pluginId: string,
  version: string,
  slug: string,
  tools: readonly Tool[],
  registered: ReadonlySet<string> = new Set(),
  known: ReadonlyMap<string, string> = new Map(),
): readonly ObservedTool[] {
  // Ids of this server's own tools never count as taken by others; an id already given to a tool keeps it.
  const own = `mcp.${slug}.`;
  const taken = new Set([...registered].filter((id) => !id.startsWith(own)));
  for (const id of known.values()) taken.add(id);
  const names = tools.map((tool) => tool.name);
  return tools.map((tool) => {
    const definition = definitionOf(tool);
    const toolId = known.get(tool.name) ?? toolIdFor(slug, tool.name, taken);
    taken.add(toolId);
    const suggestion = suggestEffect(definition.annotations);
    return {
      pluginId,
      version,
      name: tool.name,
      toolId,
      observedDefHash: definitionHash(definition),
      observedDef: definition,
      suggestedEffect: suggestion.effect,
      ...(suggestion.minRisk === undefined ? {} : { suggestedMinRisk: suggestion.minRisk }),
      doubtful: suggestion.effect === "read-only" && writeNamed(tool.name),
      flagged:
        definitionFlags(
          definition,
          names.filter((name) => name !== tool.name),
        ).length > 0,
    };
  });
}

/**
 * Whether a tool asks once under taint: every tool of a server that can reach the network (a remote one, or
 * a stdio one with any domain), and on a no-network stdio server every tool
 * that is not read-only (its home and write paths persist).
 */
function asksUnderTaint(effect: ToolEffect, egress: boolean): boolean {
  return egress || effect !== "read-only";
}

/** What a preset adds to the review: a checked effect in place of the annotations', and floors. */
export interface PresetRules {
  /** Rule 5: an effect only where the annotations were checked and found wrong; undefined keeps theirs. */
  readonly effect?: (name: string) => ToolEffect | undefined;
  readonly floors: (tool: {
    readonly name: string;
    readonly effect: ToolEffect;
  }) => { readonly minRisk?: RiskLevel; readonly argFloors?: readonly McpArgFloor[] } | undefined;
}

/** What the operator said at `approve`, by the server's tool name. */
export interface ReviewChoices {
  readonly effects: Readonly<Record<string, ToolEffect>>;
  readonly floors: Readonly<Record<string, RiskLevel>>;
  readonly timeouts: Readonly<Record<string, number>>;
  readonly disabled: ReadonlySet<string>;
}

/** The higher of two optional floors. */
function higherRisk(left: RiskLevel | undefined, right: RiskLevel | undefined): RiskLevel | undefined {
  if (left === undefined) return right;
  return right === undefined ? left : maxRisk(left, right);
}

/** A decision made before for the same definition: this version's own, or an earlier version's. */
export interface CarriedDecision {
  readonly decision: McpToolDecision | "disabled";
  /** The version it was made for. */
  readonly from: string;
}

/**
 * The decisions that carry over to `tools`: a tool
 * approved at its current definition keeps its decision, a disabled one stays
 * disabled, and a tool whose definition an earlier version approved (or
 * disabled) as it is now takes that decision. A changed tool carries nothing.
 */
export function carriedDecisions(tools: readonly McpToolRecord[], earlier: readonly McpToolRecord[]): ReadonlyMap<string, CarriedDecision> {
  const carried = new Map<string, CarriedDecision>();
  const newestFirst = [...earlier].sort((a, b) => comparePluginVersions(b.version, a.version));
  for (const tool of tools) {
    if (tool.state === "approved" && tool.decision !== undefined && tool.approvedDefHash === tool.observedDefHash) {
      carried.set(tool.name, { decision: tool.decision, from: tool.version });
      continue;
    }
    if (tool.state === "disabled") {
      carried.set(tool.name, { decision: "disabled", from: tool.version });
      continue;
    }
    if (tool.state === "withheld") continue;
    const before = newestFirst.find(
      (candidate) =>
        candidate.name === tool.name &&
        candidate.version !== tool.version &&
        ((candidate.decision !== undefined && candidate.approvedDefHash === tool.observedDefHash) ||
          (candidate.state === "disabled" && candidate.observedDefHash === tool.observedDefHash)),
    );
    if (before !== undefined)
      carried.set(tool.name, {
        decision: before.state === "disabled" ? "disabled" : (before.decision as McpToolDecision),
        from: before.version,
      });
  }
  return carried;
}

/**
 * Each tool's decision: a carried one, else the suggestion, changed by the
 * operator's choices. A doubtful or flagged tool with nothing carried has no
 * default: it needs an explicit effect, or `--disable`, or approval is
 * refused naming it. So an upgrade or a re-approval after
 * drift asks only about what changed.
 */
export function decide(
  tools: readonly McpToolRecord[],
  choices: ReviewChoices,
  egress: boolean,
  carried: ReadonlyMap<string, CarriedDecision> = new Map(),
  /**
   * A preset: its effect replaces the annotations' suggestion; its argument floors always apply (they
   * fail closed); its risk floor joins the suggestion.
   */
  preset?: PresetRules,
): Readonly<Record<string, McpToolDecision | "disabled">> {
  const named = new Set(tools.map((tool) => tool.name));
  const unknown = [
    ...Object.keys(choices.effects),
    ...Object.keys(choices.floors),
    ...Object.keys(choices.timeouts),
    ...choices.disabled,
  ].filter((name) => !named.has(name));
  if (unknown.length > 0) throw new TaviError("INVALID_INPUT", `the server has no tool named ${[...new Set(unknown)].join(", ")}`);
  const undecided = tools.filter(
    (tool) =>
      tool.state !== "removed" &&
      (tool.doubtful || tool.flagged) &&
      !carried.has(tool.name) &&
      choices.effects[tool.name] === undefined &&
      !choices.disabled.has(tool.name),
  );
  if (undecided.length > 0) {
    throw new TaviError(
      "CONFLICT",
      `choose for ${undecided.map((tool) => `${tool.name} (${tool.doubtful ? "claims read-only but has a write name" : "its description or schema reads like instructions"})`).join(", ")}: --effect <tool>=<effect> or --disable <tool>`,
    );
  }
  const decisions: Record<string, McpToolDecision | "disabled"> = {};
  for (const tool of tools) {
    if (tool.state === "removed") continue;
    const before = carried.get(tool.name)?.decision;
    // Only an explicit effect turns a disabled tool back on: a floor or a timeout alone keeps it off.
    if (choices.disabled.has(tool.name) || (before === "disabled" && choices.effects[tool.name] === undefined)) {
      decisions[tool.name] = "disabled";
      continue;
    }
    const prior = before === "disabled" ? undefined : before;
    const effect = choices.effects[tool.name] ?? prior?.effect ?? preset?.effect?.(tool.name) ?? tool.suggestedEffect;
    // The suggested floor follows the suggested effect: confirmed, it stays; another effect starts with none. A carried
    // decision keeps its own floor for its own effect.
    const fromPreset = preset?.floors({ name: tool.name, effect });
    const suggested = effect === tool.suggestedEffect ? tool.suggestedMinRisk : undefined;
    // A preset's floor applies over a carried decision too, so a stricter preset reaches a re-approval.
    const minRisk =
      choices.floors[tool.name] ??
      (prior !== undefined && effect === prior.effect
        ? higherRisk(prior.minRisk, fromPreset?.minRisk)
        : higherRisk(fromPreset?.minRisk, suggested));
    const timeoutMs = choices.timeouts[tool.name] ?? prior?.timeoutMs ?? tool.decision?.timeoutMs ?? MCP_TOOL_TIMEOUT_MS.default;
    const floors = fromPreset?.argFloors ?? (prior ?? tool.decision)?.argFloors;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MCP_TOOL_TIMEOUT_MS.max)
      throw new TaviError("INVALID_INPUT", `${tool.name}'s timeout must be 1000 to ${String(MCP_TOOL_TIMEOUT_MS.max)} ms`);
    decisions[tool.name] = {
      effect,
      ...(minRisk === undefined ? {} : { minRisk }),
      ...(floors === undefined ? {} : { argFloors: floors }),
      timeoutMs,
      askTainted: asksUnderTaint(effect, egress),
    };
  }
  return decisions;
}
