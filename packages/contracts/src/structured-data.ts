import { htmlToText } from "./html-text.js";

/**
 * What `browser.structured` reads from a page: its JSON-LD and microdata items whose type is on an allowlist,
 * `@graph` flattened, text that is HTML read as a person sees it
 * (`dropHidden`). Pure: the browser gathers the raw blocks without running any
 * of the page's scripts; this reads them.
 */
export const STRUCTURED_DATA_TYPES = [
  "LocalBusiness",
  "Restaurant",
  "MedicalBusiness",
  "Physician",
  "Dentist",
  "AutoRepair",
  "OpeningHoursSpecification",
  "Offer",
  "ReserveAction",
  "JobPosting",
  // A trending list and what it lists: a hot list's ItemList of ListItems, and the article, post or video each names.
  "ItemList",
  "ListItem",
  "NewsArticle",
  "Article",
  "SocialMediaPosting",
  "DiscussionForumPosting",
  "VideoObject",
] as const;

/** The most of a page's structured data read, in characters of JSON-LD and microdata together. */
export const STRUCTURED_DATA_MAX_CHARS = 256 * 1024;
/** Items one read answers with. */
export const STRUCTURED_DATA_MAX_ITEMS = 50;
const DEPTH_MAX = 8;
const STRING_MAX = 16 * 1024;

/** A microdata item as the browser gathers it: its type URLs and each property's values, nested items as items. */
export interface MicrodataItem {
  readonly types: readonly string[];
  readonly properties: Readonly<Record<string, readonly (string | MicrodataItem)[]>>;
}

/** What the page held: each `application/ld+json` block's text, and its top-level microdata items. */
export interface StructuredBlocks {
  readonly jsonLd: readonly string[];
  readonly microdata: readonly MicrodataItem[];
}

export interface StructuredData {
  readonly items: readonly Record<string, unknown>[];
  /** Blocks that were not JSON, or past the size cap. */
  readonly skipped: number;
}

/** A type's name, from a URL such as `https://schema.org/JobPosting` too. */
const typeName = (value: string): string => value.split(/[/#]/).pop() ?? value;
const typesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((type): type is string => typeof type === "string").map(typeName);

/** A value as a reader sees it: text that is HTML through `dropHidden`, nested values cleaned the same way. */
function clean(value: unknown, depth: number): unknown {
  if (depth > DEPTH_MAX) return undefined;
  if (typeof value === "string") {
    const text = value.length > STRING_MAX ? value.slice(0, STRING_MAX) : value;
    return /<\/?[a-z][^>]*>/i.test(text) ? htmlToText(text, { dropHidden: true }) : text;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => [key, clean(item, depth + 1)]),
    );
  }
  return value;
}

/** A microdata item in JSON-LD's shape: `@type`, then each property, one value or a list. */
function fromMicrodata(item: MicrodataItem, depth: number): Record<string, unknown> {
  const properties = Object.entries(item.properties).map(([name, values]) => {
    const read = values
      .slice(0, 20)
      .map((value) => (typeof value === "string" ? value : depth < DEPTH_MAX ? fromMicrodata(value, depth + 1) : undefined))
      .filter((value) => value !== undefined);
    return [name, read.length === 1 ? read[0] : read] as const;
  });
  return { "@type": item.types.map(typeName).slice(0, 4), ...Object.fromEntries(properties) };
}

/** The most nodes the owner walks of what a page's gatherer answered: an answer is untrusted, and may share references. */
export const STRUCTURED_BLOCKS_MAX_NODES = 20_000;
const BLOCKS_MAX = 20;

/**
 * What a page's gatherer answered, copied into fresh, plain blocks within
 * bounds before anything else reads it. The gatherer runs in the page's own
 * script context, so a hostile page can answer anything, including a small
 * graph whose shared references expand without end: every node walked counts
 * against `STRUCTURED_BLOCKS_MAX_NODES`, and the copy stops there.
 */
export function sanitizeStructuredBlocks(raw: unknown): StructuredBlocks {
  let nodes = 0;
  let chars = 0;
  const spend = (): boolean => (nodes += 1) <= STRUCTURED_BLOCKS_MAX_NODES;
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string" || chars >= STRUCTURED_DATA_MAX_CHARS) return undefined;
    const kept = value.slice(0, STRUCTURED_DATA_MAX_CHARS - chars);
    chars += kept.length;
    return kept;
  };
  const item = (value: unknown, depth: number): MicrodataItem | undefined => {
    if (!spend() || depth > DEPTH_MAX || typeof value !== "object" || value === null) return undefined;
    const record = value as { readonly types?: unknown; readonly properties?: unknown };
    const types = (Array.isArray(record.types) ? record.types.slice(0, 4) : [])
      .map(text)
      .filter((type): type is string => type !== undefined);
    const properties: Record<string, (string | MicrodataItem)[]> = {};
    if (typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)) {
      for (const [name, values] of Object.entries(record.properties).slice(0, 80)) {
        if (!spend() || !Array.isArray(values)) continue;
        const kept = values
          .slice(0, 20)
          .map((entry) => (typeof entry === "string" ? (spend() ? text(entry) : undefined) : item(entry, depth + 1)))
          .filter((entry): entry is string | MicrodataItem => entry !== undefined);
        properties[name.slice(0, 64)] = kept;
      }
    }
    return { types, properties };
  };
  const blocks = typeof raw === "object" && raw !== null ? (raw as { readonly jsonLd?: unknown; readonly microdata?: unknown }) : {};
  const jsonLd = (Array.isArray(blocks.jsonLd) ? blocks.jsonLd.slice(0, BLOCKS_MAX) : [])
    .map((block) => (spend() ? text(block) : undefined))
    .filter((block): block is string => block !== undefined);
  const microdata = (Array.isArray(blocks.microdata) ? blocks.microdata.slice(0, BLOCKS_MAX) : [])
    .map((entry) => item(entry, 0))
    .filter((entry): entry is MicrodataItem => entry !== undefined);
  return { jsonLd, microdata };
}

/** The allowlisted items of a page's structured data, `@graph` flattened; `types` narrows the allowlist (a profile's `extract.jsonLdTypes`). */
export function readStructuredData(blocks: StructuredBlocks, types: readonly string[] = STRUCTURED_DATA_TYPES): StructuredData {
  const allowed = new Set(types.filter((type) => (STRUCTURED_DATA_TYPES as readonly string[]).includes(type)));
  const items: Record<string, unknown>[] = [];
  let skipped = 0;
  let read = 0;
  const keep = (value: unknown): void => {
    if (items.length >= STRUCTURED_DATA_MAX_ITEMS || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) keep(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["@graph"])) {
      for (const item of record["@graph"]) keep(item);
      return;
    }
    if (typesOf(record["@type"]).some((type) => allowed.has(type))) items.push(clean(record, 0) as Record<string, unknown>);
  };
  for (const block of blocks.jsonLd) {
    read += block.length;
    if (read > STRUCTURED_DATA_MAX_CHARS) {
      skipped += 1;
      continue;
    }
    try {
      keep(JSON.parse(block));
    } catch {
      skipped += 1;
    }
  }
  for (const item of blocks.microdata) {
    const record = fromMicrodata(item, 0);
    read += JSON.stringify(record).length;
    if (read > STRUCTURED_DATA_MAX_CHARS) {
      skipped += 1;
      continue;
    }
    keep(record);
  }
  return { items, skipped };
}
