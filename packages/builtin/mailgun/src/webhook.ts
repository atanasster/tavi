import { TaviError, type InboundMediaHandle, type IngressContext, type IngressRequest, type MessagingIngress } from "@tavi/contracts";

import { DEFAULT_TOLERANCE_SECONDS, toInboundEvent, verifyMailgunSignature, type MailgunInboundFields } from "./inbound.js";

/**
 * Mailgun's inbound webhook as the host's ingress takes it: one `inbound` route per connection,
 * whose POST is Mailgun's `multipart/form-data` route forward. The host owns
 * the listener, the body cap (`DEFAULT_MAX_BODY_BYTES`, the route carries
 * attachments), rate limiting and the replay cache; this checks a request's
 * signature against the connection's webhook signing key and turns it into
 * the event it carries.
 *
 * Mailgun's HMAC covers only `timestamp + token`, never the body, so a
 * captured signed request could be resent with another body while fresh:
 * the token is the replay key, remembered for the
 * signature's whole validity — twice the tolerance, since a timestamp may run
 * ahead, plus a minute of slack.
 */

/** The largest inbound POST taken: a real email's text parts, headers and attachments, with room to spare. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const REPLAY_TTL_MS = (2 * DEFAULT_TOLERANCE_SECONDS + 60) * 1000;

type SignedFields = MailgunInboundFields & { readonly timestamp?: string; readonly token?: string; readonly signature?: string };

function extractBoundary(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2]?.trim();
}

/** A file part of the body: an attachment of the email, as Mailgun forwards it. */
interface MultipartFile {
  readonly filename: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
}

/**
 * A minimal `multipart/form-data` parser for Mailgun's inbound POST: its
 * text fields, and apart from them its file parts (a `Content-Disposition`
 * carrying `filename=`) — the email's attachments, never decoded as text
 * and never taken for a field, which the host takes in as media.
 *
 * **Strict CRLF, no bare-LF fallback.** All framing (`\r\n\r\n` between
 * headers and content, `\r\n` around each boundary marker) is matched as
 * an exact literal, per RFC 2046. If an intermediary ever normalized
 * line endings to bare `\n` before this handler saw the body, every
 * field lookup would fail and the request would end up rejected as
 * "missing signature fields" — a fail-safe outcome, but not a
 * self-diagnosing one; if inbound Mailgun traffic is ever silently
 * empty-fielded in production, a normalizing proxy in front of this
 * endpoint is the first thing to check.
 */
function parseMultipartFields(
  body: Buffer,
  boundary: string,
): { readonly fields: Record<string, string>; readonly files: readonly MultipartFile[] } {
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];
  for (const part of splitMultipartBody(body, boundary)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);

    const dispositionMatch = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    if (dispositionMatch === null) continue;
    const name = dispositionMatch[1];
    const filename = dispositionMatch[2];
    if (name === undefined) continue;
    if (filename !== undefined) {
      const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim();
      files.push({
        filename: filename === "" ? "attachment" : filename,
        ...(contentType === undefined ? {} : { contentType }),
        bytes: new Uint8Array(content),
      });
      continue;
    }
    fields[name] = content.toString("utf8");
  }
  return { fields, files };
}

/**
 * Finds the next occurrence of `marker` that is genuinely a delimiter
 * line — per RFC 2046's `CRLF "--" boundary` grammar, a match only
 * counts if it sits at the very start of the buffer or is immediately
 * preceded by `\r\n`. Without this anchor, a raw substring search can be
 * fooled by a part's own content happening to contain the literal
 * `--boundary` bytes (real risk: quoted/forwarded email text), silently
 * truncating and corrupting the rest of the parse.
 */
function indexOfDelimiter(body: Buffer, marker: Buffer, from: number): number {
  let index = body.indexOf(marker, from);
  while (index > 0 && !(body[index - 2] === 0x0d && body[index - 1] === 0x0a)) {
    index = body.indexOf(marker, index + 1);
  }
  return index;
}

/**
 * Splits a `multipart/form-data` body into its individual parts' raw
 * bytes (headers + content, still CRLF-joined — `parseMultipartFields`
 * splits headers from content itself). Each part sits between one
 * `--boundary\r\n` marker and the next `--boundary` marker, with exactly
 * one trailing `\r\n` (immediately before the next marker) stripped; the
 * closing `--boundary--` marker produces no further part.
 */
function splitMultipartBody(body: Buffer, boundary: string): readonly Buffer[] {
  const marker = Buffer.from(`--${boundary}`, "utf8");
  const parts: Buffer[] = [];
  let cursor = indexOfDelimiter(body, marker, 0);
  if (cursor === -1) return parts;
  cursor += marker.length;
  for (;;) {
    if (body.subarray(cursor, cursor + 2).toString("utf8") === "--") break; // closing boundary
    if (body.subarray(cursor, cursor + 2).toString("utf8") === "\r\n") cursor += 2;
    const next = indexOfDelimiter(body, marker, cursor);
    if (next === -1) break;
    const end = body.subarray(next - 2, next).toString("utf8") === "\r\n" ? next - 2 : next;
    parts.push(body.subarray(cursor, end));
    cursor = next + marker.length;
  }
  return parts;
}

interface ParsedRequest {
  readonly fields: SignedFields;
  readonly files: readonly MultipartFile[];
}

/** The fields and files of a request's multipart body, parsed once per request. */
function fieldsOf(request: IngressRequest, cache: WeakMap<IngressRequest, ParsedRequest>): ParsedRequest {
  const cached = cache.get(request);
  if (cached !== undefined) return cached;
  const boundary = extractBoundary(request.headers["content-type"]);
  if (boundary === undefined) throw new TaviError("INVALID_INPUT", "expected multipart/form-data with a boundary");
  const body = Buffer.from(request.rawBody.buffer, request.rawBody.byteOffset, request.rawBody.byteLength);
  const parsed = parseMultipartFields(body, boundary);
  // A non-trivial body the parser took nothing from is malformed (no closing
  // boundary, bare-LF line endings), not merely incomplete.
  if (Object.keys(parsed.fields).length === 0 && body.byteLength > 0)
    throw new TaviError("INVALID_INPUT", "no multipart fields could be parsed from the request body");
  cache.set(request, parsed);
  return parsed;
}

export function createMailgunIngress(): MessagingIngress {
  const parsed = new WeakMap<IngressRequest, ParsedRequest>();
  return {
    async verify(request: IngressRequest, context: IngressContext) {
      let fields: SignedFields;
      try {
        fields = fieldsOf(request, parsed).fields;
      } catch {
        return { ok: false };
      }
      const { timestamp, token, signature } = fields;
      const signingKey = await context.credentials.get("webhookSigningKey");
      if (timestamp === undefined || token === undefined || signature === undefined || signingKey === null) return { ok: false };
      if (!verifyMailgunSignature({ signingKey, fields: { timestamp, token, signature }, now: context.now })) return { ok: false };
      return { ok: true, replayKey: token, replayTtlMs: REPLAY_TTL_MS };
    },
    async handle(request: IngressRequest, context: IngressContext) {
      const { fields, files } = fieldsOf(request, parsed);
      const event = toInboundEvent(context.connection.connectionId, fields, context.now());
      // The attachments came in the request: handed over as they are, for the host to check and keep or skip.
      const media = files.map(
        (file, index): InboundMediaHandle => ({
          ref: `attachment-${index + 1}`,
          filename: file.filename,
          ...(file.contentType === undefined ? {} : { mimeType: file.contentType }),
          sizeBytes: file.bytes.byteLength,
          inline: file.bytes,
        }),
      );
      return { events: [media.length === 0 ? event : { ...event, media }] };
    },
  };
}
