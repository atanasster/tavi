import { TaviError, normaliseUntrustedText, withoutControls } from "@tavi/contracts";

/**
 * What an MCP server says, made safe to store, show and pass on.
 */

/** Characters of a tool error's text kept from the server. */
const MAX_ERROR_TEXT = 500;
/** Characters kept of each embedded resource's text. */
const MAX_EMBEDDED_TEXT = 16 * 1024;

/** U+2028 and U+2029, which end a line wherever they are read. */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Server text as Tavi stores and shows it: no escape sequences, no C0/C1
 * controls (newline and tab kept), no format characters (bidirectional
 * overrides, zero-width characters, Unicode tags), line and paragraph
 * separators as newlines, and every forged envelope fence or chat-template
 * token rewritten as its quoted form (`normaliseUntrustedText`).
 */
export function cleanServerText(text: string): string {
  const plain = withoutControls(text)
    .replace(LINE_SEPARATORS, "\n")
    .replace(/\p{Cf}/gu, "");
  return normaliseUntrustedText(plain);
}

/** A server's words as a person or the model is shown them on one line: cleaned, its whitespace runs one space, cut at `max`. */
export function serverLine(text: string, max: number): string {
  return cleanServerText(text).replace(/\s+/g, " ").trim().slice(0, max);
}

/** A server's name as the model and the review show it: the operator's manifest name, cleaned, on one line, at most 60 characters. */
export function mcpServerDisplayName(name: string): string {
  return cleanServerText(name).replace(/\s+/g, " ").slice(0, 60);
}

// What an MCP tool's result is labelled: contracts', shared with tool plugins.
export { mcpResultLabel } from "@tavi/contracts";

/** An image a tool returned, for a provider that accepts images. */
interface McpImage {
  readonly mimeType: string;
  readonly data: string;
}

/** A tool's result as Tavi passes it on. */
export interface McpCallResult {
  /** `structuredContent`, else the text items joined, else `undefined`. */
  readonly content: unknown;
  /** The text items, cleaned and joined; `undefined` when there were none. */
  readonly text?: string;
  readonly images: readonly McpImage[];
  /** `resource_link` items: listed, never fetched. */
  readonly links: readonly { readonly uri: string; readonly name?: string }[];
  /** The server answered with `structuredContent` (what `content` then is), which its output schema describes. */
  readonly structured?: true;
}

interface ContentItem {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly uri?: unknown;
  readonly name?: unknown;
  readonly resource?: { readonly uri?: unknown; readonly text?: unknown; readonly mimeType?: unknown };
}

/**
 * Deep-cleans every string in a structured value (keys included), so no server string escapes cleaning: a result's
 * structured content, and a tool's input and output schemas (`cleanDefinition`).
 */
export function cleanStructured(value: unknown, depth = 0): unknown {
  // Past the limit the subtree is replaced, never passed on uncleaned.
  if (depth > 64) return "[nested too deep]";
  if (typeof value === "string") return cleanServerText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cleanStructured(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanServerText(key), cleanStructured(item, depth + 1)]));
}

/**
 * A `tools/call` result as Tavi passes it on: an `isError` result is a tool
 * error carrying the server's text (500 characters); otherwise the structured
 * content, else the text items joined, with images kept aside and resource
 * links listed. Every string is cleaned.
 */
export function mapToolResult(
  tool: string,
  result: { readonly isError?: unknown; readonly structuredContent?: unknown; readonly content?: unknown },
): McpCallResult {
  const items = Array.isArray(result.content) ? (result.content as ContentItem[]) : [];
  const texts: string[] = [];
  const images: McpImage[] = [];
  const links: { uri: string; name?: string }[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type === "text" && typeof item.text === "string") texts.push(cleanServerText(item.text));
    else if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string" &&
      /^image\/[a-z0-9.+-]+$/i.test(item.mimeType)
    )
      images.push({ mimeType: item.mimeType, data: item.data });
    else if (item.type === "resource_link" && typeof item.uri === "string")
      links.push({
        uri: cleanServerText(item.uri).slice(0, 2048),
        ...(typeof item.name === "string" ? { name: cleanServerText(item.name).slice(0, 200) } : {}),
      });
    else if (item.type === "resource" && typeof item.resource?.text === "string")
      texts.push(cleanServerText(item.resource.text).slice(0, MAX_EMBEDDED_TEXT));
  }
  const text = texts.length === 0 ? undefined : texts.join("\n\n");
  if (result.isError === true)
    throw new TaviError("UNAVAILABLE", `${tool} failed: ${(text ?? "no reason given").slice(0, MAX_ERROR_TEXT)}`, {
      details: { mcpFailure: "tool" },
    });
  const structured = result.structuredContent;
  return {
    content: structured !== undefined && structured !== null ? cleanStructured(structured) : text,
    ...(structured !== undefined && structured !== null ? { structured: true as const } : {}),
    ...(text === undefined ? {} : { text }),
    images,
    links,
  };
}
