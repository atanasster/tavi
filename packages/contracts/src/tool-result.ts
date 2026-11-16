import { z } from "zod";

// Acyclic: content-label.ts imports only zod.
import {
  CONTENT_LABEL_LIMITS,
  ConfidentialitySchema,
  ContentLabelSchema,
  SourceKindSchema,
  TRUSTED_PUBLIC,
  joinLabels,
  maxConfidentiality,
  normalizeLabel,
  trustedLabel,
  type Confidentiality,
  type ContentLabel,
  type LabelRef,
  type SourceKind,
} from "./content-label.js";
import { normalizeUrl } from "./known-url.js";

/**
 * What a tool's result carries besides its output: the keys a handler sets
 * for an image, a document or a video the model is shown, for a result that
 * is untrusted though its tool is not, and for the label its content takes
 * (`toolResultLabel`).
 */

/**
 * A tool result that shows the model an image: the result names an
 * approved artifact, and the model adapter puts its bytes in front of a
 * vision-capable model. The bytes never enter the conversation or its
 * checkpoint — only this reference does.
 */
export const TOOL_MEDIA_KEY = "taviMedia";

/**
 * The key a handler sets `true` in its result when this one result is
 * untrusted though its tool is not (`untrustedOutput` is per tool): `fs.read`
 * of a file a web page supplied, in the chat's `downloads/`. The dispatcher
 * removes it and marks the tool message `untrusted`, which
 * taints the conversation as an `untrustedOutput` tool's result does.
 */
export const TOOL_UNTRUSTED_KEY = "taviUntrusted";

/** A result without `TOOL_UNTRUSTED_KEY`, and whether the handler set it. */
export function untrustedResult(output: unknown): { readonly output: unknown; readonly untrusted: boolean } {
  if (typeof output !== "object" || output === null || Array.isArray(output) || !Object.hasOwn(output, TOOL_UNTRUSTED_KEY))
    return { output, untrusted: false };
  const { [TOOL_UNTRUSTED_KEY]: flag, ...rest } = output as Record<string, unknown>;
  return { output: rest, untrusted: flag === true };
}
/**
 * The key a handler sets in its result to label this one result, beside
 * the tool's static `untrustedOutput`,
 * `outputSource` and `outputConfidentiality`. It can only raise: make the
 * result untrusted, name its source, raise its confidentiality (a
 * credentialed `http.request`, a host-folder read), add refs (the chats a
 * `sessions.search` hit) — never lower what the tool declares. The dispatcher
 * removes it, with `TOOL_UNTRUSTED_KEY`, before anything keeps the result.
 */
export const TOOL_LABEL_KEY = "taviLabel";

/** What a handler may say of one result under `TOOL_LABEL_KEY`. */
export const ToolResultLabelSchema = z.strictObject({
  untrusted: z.literal(true).optional(),
  source: SourceKindSchema.optional(),
  confidentiality: ConfidentialitySchema.optional(),
  /** What Tavi parsed of where it came from: a page's host. */
  host: z.string().min(1).max(CONTENT_LABEL_LIMITS.maxHostLength).optional(),
  /** What the page calls itself (`pageResultLabel`): display only, shown after the host and neutralised. A built-in's only, like a host. */
  title: z.string().min(1).max(CONTENT_LABEL_LIMITS.maxTitleLength).optional(),
  /** More refs under the result's source: the task ids a `sessions.search` hit. */
  refs: z.array(z.string().min(1).max(CONTENT_LABEL_LIMITS.maxRefLength)).max(16).optional(),
  principals: z.array(z.string().min(1).max(CONTENT_LABEL_LIMITS.maxPrincipalLength)).max(8).optional(),
  /**
   * A whole label the result's content was stored with, joined in as it
   * is: an artifact read back (`agents.read_payload`, `artifacts.view_image`)
   * carries what it was stored with, of any sources and refs, which the
   * fields above cannot say. A built-in's only, like a source.
   */
  stored: ContentLabelSchema.optional(),
});
export type ToolResultLabel = z.infer<typeof ToolResultLabelSchema>;

/**
 * A result without `TOOL_UNTRUSTED_KEY` and `TOOL_LABEL_KEY`, and what they
 * said. A label the schema refuses fails safe: the result reads as untrusted.
 */
export function labelledResult(output: unknown): {
  readonly output: unknown;
  readonly untrusted: boolean;
  readonly label?: ToolResultLabel;
} {
  const marked = untrustedResult(output);
  const rest = marked.output;
  if (typeof rest !== "object" || rest === null || Array.isArray(rest) || !Object.hasOwn(rest, TOOL_LABEL_KEY)) return marked;
  const { [TOOL_LABEL_KEY]: raw, ...unlabelled } = rest as Record<string, unknown>;
  const parsed = ToolResultLabelSchema.safeParse(raw);
  return parsed.success ? { output: unlabelled, untrusted: marked.untrusted, label: parsed.data } : { output: unlabelled, untrusted: true };
}

/**
 * What a page result's label says of where it came from (`TOOL_LABEL_KEY`):
 * the host Tavi parsed from the page's own URL — the one it ended on,
 * after redirects — and the title the page gives itself, clipped, display
 * only: `provenanceChips` shows it after the host, neutralised.
 */
export function pageResultLabel(url: unknown, title?: unknown): { readonly host?: string; readonly title?: string } {
  const host = hostOfUrl(url);
  // Cut by UTF-16 units, as the schema bounds it; a pair the cut splits is dropped.
  const named =
    typeof title === "string"
      ? title
          .trim()
          .slice(0, CONTENT_LABEL_LIMITS.maxTitleLength)
          .replace(/[\uD800-\uDBFF]$/, "")
          .trim()
      : "";
  return { ...(host === undefined ? {} : { host }), ...(named === "" ? {} : { title: named }) };
}

/** The host of an http(s) URL, lower-cased, without userinfo or port, as a label names it; undefined for anything else. */
export function hostOfUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeUrl(value);
  if (normalized === undefined) return undefined;
  const authority = normalized.slice(normalized.indexOf("//") + 2).split("/", 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : (hostPort.split(":", 1)[0] ?? "");
  return host === "" || host.length > CONTENT_LABEL_LIMITS.maxHostLength ? undefined : host.toLowerCase();
}

/**
 * The label of one tool result as it enters the conversation:
 *
 * - integrity is untrusted when the tool is `untrustedOutput`, or the handler
 *   marked this result (`TOOL_UNTRUSTED_KEY`, or `untrusted` under
 *   `TOOL_LABEL_KEY`);
 * - the source is the handler's, else the tool's `outputSource`, else
 *   `download` (what `TOOL_UNTRUSTED_KEY` means) for a
 *   built-in or `plugin` for an external tool — the registry stamps that one;
 * - confidentiality is the highest of the tool's, the handler's, and
 *   `secret` when the result held a redaction placeholder before scrubbing;
 * - an untrusted result names its source, its host (the handler's, else the
 *   host of the call's `url` input) as `host:<h>`, and the call id as a ref.
 *
 * A trusted result carries its confidentiality alone: no source, no ref. Only
 * a built-in's handler may name a source, host, principals or refs; an
 * external plugin's or MCP tool's may only raise integrity and confidentiality,
 * so its output keeps the provenance Tavi gave it. A built-in's `stored`
 * label (an artifact's) is joined in whole.
 */
export function toolResultLabel(
  definition: {
    readonly untrustedOutput?: boolean | undefined;
    readonly outputSource?: SourceKind | undefined;
    readonly outputConfidentiality?: Confidentiality | undefined;
    readonly outputPrincipal?: string | undefined;
    readonly builtIn?: true | undefined;
  },
  call: { readonly id: string; readonly input: unknown },
  given: { readonly untrusted: boolean; readonly label?: ToolResultLabel | undefined; readonly secret?: boolean | undefined },
  at: string,
): ContentLabel {
  const result =
    definition.builtIn === true || given.label === undefined
      ? given
      : {
          ...given,
          label: {
            ...(given.label.untrusted === undefined ? {} : { untrusted: given.label.untrusted }),
            ...(given.label.confidentiality === undefined ? {} : { confidentiality: given.label.confidentiality }),
          },
        };
  const own = callResultLabel(definition, call, result, at);
  return result.label?.stored === undefined ? own : joinLabels(own, result.label.stored);
}

function callResultLabel(
  definition: {
    readonly untrustedOutput?: boolean | undefined;
    readonly outputSource?: SourceKind | undefined;
    readonly outputConfidentiality?: Confidentiality | undefined;
    readonly outputPrincipal?: string | undefined;
  },
  call: { readonly id: string; readonly input: unknown },
  result: { readonly untrusted: boolean; readonly label?: ToolResultLabel | undefined; readonly secret?: boolean | undefined },
  at: string,
): ContentLabel {
  const confidentiality = maxConfidentiality(
    maxConfidentiality(definition.outputConfidentiality ?? "public", result.label?.confidentiality ?? "public"),
    result.secret === true ? "secret" : "public",
  );
  const untrusted = definition.untrustedOutput === true || result.untrusted || result.label?.untrusted === true;
  if (!untrusted) return confidentiality === "public" ? TRUSTED_PUBLIC : trustedLabel(confidentiality);
  const source: SourceKind = result.label?.source ?? definition.outputSource ?? "download";
  const input = call.input;
  // A tool that names who said its output (an MCP server, `tool:<name>`) is known by that name where no URL names a host.
  const named = definition.outputPrincipal?.startsWith("tool:") === true ? definition.outputPrincipal.slice("tool:".length) : undefined;
  // That name wins over any URL in the arguments, which the model chose.
  const host =
    named ??
    result.label?.host ??
    (typeof input === "object" && input !== null && !Array.isArray(input)
      ? hostOfUrl((input as Record<string, unknown>)["url"])
      : undefined);
  const title = result.label?.title;
  const callRef: LabelRef = {
    source,
    ref: call.id.slice(0, CONTENT_LABEL_LIMITS.maxRefLength),
    ...(host === undefined ? {} : { host }),
    ...(title === undefined ? {} : { title }),
    at,
  };
  return normalizeLabel({
    integrity: "untrusted",
    sources: [source],
    principals: [
      ...(definition.outputPrincipal === undefined ? (host === undefined ? [] : [`host:${host}`]) : [definition.outputPrincipal]),
      ...(result.label?.principals ?? []),
    ],
    confidentiality,
    refs: [callRef, ...(result.label?.refs ?? []).map((ref) => ({ source, ref, at }))],
  });
}

export interface ToolMediaReference {
  readonly artifactId: string;
  readonly mediaType: string;
}

/**
 * The most image references one tool result carries: a render of three
 * pages is one result. A result over it carries none
 * the adapter reads.
 */
export const TOOL_MEDIA_MAX = 3;

function mediaReference(media: unknown): ToolMediaReference | undefined {
  if (typeof media !== "object" || media === null) return undefined;
  const { artifactId, mediaType } = media as Record<string, unknown>;
  return typeof artifactId === "string" && typeof mediaType === "string" && /^image\/[a-z0-9.+-]+$/.test(mediaType)
    ? { artifactId, mediaType }
    : undefined;
}

/**
 * The image references a tool result carries, in order: one reference
 * (every single-image tool, MCP's included), or a list of at most
 * `TOOL_MEDIA_MAX` (`pdf.render`, `pdf.fill`). A list with any entry that is
 * not an image reference, or over the cap, carries none.
 */
export function toolMediaListOf(output: unknown): ToolMediaReference[] {
  if (typeof output !== "object" || output === null) return [];
  const media = (output as Record<string, unknown>)[TOOL_MEDIA_KEY];
  if (Array.isArray(media)) {
    if (media.length === 0 || media.length > TOOL_MEDIA_MAX) return [];
    const references = media.map(mediaReference);
    return references.every((reference) => reference !== undefined) ? (references as ToolMediaReference[]) : [];
  }
  const single = mediaReference(media);
  return single === undefined ? [] : [single];
}

/**
 * Whether a tool result has a media key at all, readable or not: what a
 * text-only consumer strips, so an artifact id never reaches a model as
 * data.
 */
export function hasToolMedia(output: unknown): boolean {
  return typeof output === "object" && output !== null && TOOL_MEDIA_KEY in output;
}

/**
 * The key a result names a whole document by (`pdf.view`),
 * `{ artifactId, mediaType: "application/pdf" }`: sent as a
 * file only to a connection that takes PDFs. It is apart from
 * `TOOL_MEDIA_KEY`, so an image consumer is never handed a PDF.
 */
export const TOOL_DOCUMENT_KEY = "taviDocument";

export interface ToolDocumentReference {
  readonly artifactId: string;
  readonly mediaType: "application/pdf";
}

/** The document a tool result names, if it names one well formed. */
export function toolDocumentOf(output: unknown): ToolDocumentReference | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const document = (output as Record<string, unknown>)[TOOL_DOCUMENT_KEY];
  if (typeof document !== "object" || document === null) return undefined;
  const { artifactId, mediaType } = document as Record<string, unknown>;
  return typeof artifactId === "string" && mediaType === "application/pdf" ? { artifactId, mediaType } : undefined;
}

/**
 * The key a result names a whole video by (`video.view`), apart from the
 * document and media keys, so a PDF or
 * image consumer is never handed a video: sent only to a model the owner
 * turned native video on for, in an attended chat. Elsewhere the result's
 * fallback images stand for it.
 */
export const TOOL_VIDEO_KEY = "taviVideo";

export const TOOL_VIDEO_MEDIA_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export interface ToolVideoReference {
  readonly artifactId: string;
  readonly mediaType: (typeof TOOL_VIDEO_MEDIA_TYPES)[number];
}

/** The video a tool result names, if it names one well formed. */
export function toolVideoOf(output: unknown): ToolVideoReference | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const video = (output as Record<string, unknown>)[TOOL_VIDEO_KEY];
  if (typeof video !== "object" || video === null) return undefined;
  const { artifactId, mediaType } = video as Record<string, unknown>;
  return typeof artifactId === "string" && (TOOL_VIDEO_MEDIA_TYPES as readonly unknown[]).includes(mediaType)
    ? { artifactId, mediaType: mediaType as ToolVideoReference["mediaType"] }
    : undefined;
}

/** The first media reference a tool result carries, if it carries one. */
export function toolMediaOf(output: unknown): ToolMediaReference | undefined {
  return toolMediaListOf(output)[0];
}
