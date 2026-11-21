import {
  CONTENT_LABEL_LIMITS,
  VIDEO_MEDIA_TYPES,
  VIDEO_SNIFF_BYTES,
  sniffVideoContainer,
  untrustedLabel,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type InboundEvent,
  type InboundMediaHandle,
  type MediaResponse,
  type MessagingConnectorInstance,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * The host's intake of a message's attachments. A connector names what it received; the host alone
 * decides what is kept: nothing from a sender who is not allowed, nothing
 * over the channel's cap, nothing whose content is not a type the channel
 * takes — the type read from the bytes, not from the provider's word — and
 * every kept one an untrusted artifact. An attachment not kept is said in the
 * message, never dropped in silence.
 */

/** What a channel takes in (its descriptor's `media`); absent, it takes no attachments. */
export interface MediaPolicy {
  readonly inboundMaxBytes: number;
  /** Exact types, or `type/*` for every subtype. */
  readonly mimeTypes: readonly string[];
}

export interface MediaIntakeInput {
  readonly event: InboundEvent;
  /** The workspace whose allowed sender sent it; absent when the sender is not allowed, and then nothing is downloaded. */
  readonly allowedIn: string | undefined;
  readonly policy: MediaPolicy | undefined;
  readonly instance: Pick<MessagingConnectorInstance, "fetchMedia"> | undefined;
  readonly artifacts: {
    putArtifact(input: Parameters<ArtifactRepositoryPort["putArtifact"]>[0]): ArtifactRecord | Promise<ArtifactRecord>;
  };
  readonly timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/** The type `bytes` are, from their leading bytes; `undefined` for content none of these is. */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string): boolean => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(4, "ftyp")) return isoMediaType(bytes, ascii);
  // Matroska and WebM, by their EBML header's DocType.
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) {
    const container = sniffVideoContainer(bytes.subarray(0, VIDEO_SNIFF_BYTES));
    return container === undefined ? undefined : VIDEO_MEDIA_TYPES[container];
  }
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  // Text: valid UTF-8 with no NUL, which no binary format above avoids for long.
  if (bytes.byteLength > 0 && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/plain";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * An ISO media file's type by its major brand: a photo (HEIC, AVIF), audio
 * (`M4A `, an audiobook's `M4B `), or the video the decoder's own rule names
 * (QuickTime, 3GPP, or else MP4: an unlisted brand is still taken as MP4, as
 * it always was). A brand known not to be video, such as a camera's raw
 * `crx ` or JPEG 2000's `jp2 `, is none of these.
 */
function isoMediaType(bytes: Uint8Array, ascii: (offset: number, text: string) => boolean): string | undefined {
  if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].some((brand) => ascii(8, brand))) return "image/heic";
  if (ascii(8, "avif") || ascii(8, "avis")) return "image/avif";
  if (["M4A ", "M4B ", "M4P ", "F4A ", "F4B "].some((brand) => ascii(8, brand))) return "audio/mp4";
  const container = sniffVideoContainer(bytes.subarray(0, VIDEO_SNIFF_BYTES));
  return container === undefined ? undefined : VIDEO_MEDIA_TYPES[container];
}

export function mediaTypeAllowed(type: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => entry === type || (entry.endsWith("/*") && type.startsWith(entry.slice(0, -1))));
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "image/heic": "heic",
  "image/avif": "avif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "audio/wav": "wav",
  "text/plain": "txt",
};

/** The same attachment of the same message is the same artifact: a redelivery stores nothing new. */
function artifactIdOf(event: InboundEvent, index: number): string {
  return `art-in-${sha256Hex(`${event.connectionId}\u0000${event.providerEventId}\u0000${index}`).slice(0, 40)}`;
}

function kilobytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The line an attachment leaves in the prompt, naming its artifact. A caller
 * marks it an `attachment` quoted range: the name is the sender's to choose.
 */
export function attachmentLine(filename: string | undefined, contentType: string, byteSize: number, artifactId: string): string {
  const name = filename === undefined ? undefined : shownName(filename);
  // Audio (a voice message) is no text to read back: its line names the tool that hears it.
  const how = contentType.startsWith("audio/") ? "; what is said in it: audio.transcribe" : "";
  return `[Attachment${name === undefined ? "" : ` ${name}`} (${contentType}, ${kilobytes(byteSize)}): artifact ${artifactId}, untrusted content from the sender${how}]`;
}

/** A sender's file name as the host's own line shows it: one line, no brackets that could close it and open another. */
function shownName(filename: string): string | undefined {
  const plain = filename
    .replace(/[\u0000-\u001f\u007f[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return plain === "" ? undefined : plain;
}

/** The note a skipped attachment leaves: "1 attachment skipped: too large". */
function skippedNote(reasons: readonly string[]): string | undefined {
  if (reasons.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `[${plural(count, "attachment")} skipped: ${reason}]`).join("\n");
}

/**
 * `event` with its `media` taken in: kept ones as `attachments` and a line
 * each in the content naming the artifact, skipped ones as a note. An event
 * with no media is returned as it is. The lines and the note are marked as an
 * `attachment` quoted range: a file name is the
 * sender's to choose, so they are never the person's own words, the prompt or
 * the retrieval query — a caption stays theirs.
 */
export async function takeInMedia(input: MediaIntakeInput): Promise<InboundEvent> {
  const { media, ...event } = input.event;
  if (media === undefined || media.length === 0) return input.event;
  const kept: { readonly artifactId: string; readonly filename?: string }[] = [];
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const [index, handle] of media.entries()) {
    const outcome = await takeIn(input, handle, index);
    if (typeof outcome === "string") {
      skipped.push(outcome);
      continue;
    }
    kept.push({ artifactId: outcome.artifactId, ...(handle.filename === undefined ? {} : { filename: handle.filename }) });
    lines.push(attachmentLine(handle.filename, outcome.contentType, outcome.byteSize, outcome.artifactId));
  }
  const note = skippedNote(skipped);
  const said = [...lines, ...(note === undefined ? [] : [note])].join("\n\n");
  const caption = event.content ?? "";
  const content = [caption, said].filter((part) => part !== "").join("\n\n");
  const start = content.length - said.length;
  const quotedRanges =
    said === "" ? event.quotedRanges : [...(event.quotedRanges ?? []), { start, end: content.length, kind: "attachment" as const }];
  return {
    ...event,
    ...(content === "" ? {} : { content }),
    ...(quotedRanges === undefined ? {} : { quotedRanges }),
    ...(kept.length === 0 ? {} : { attachments: kept }),
  };
}

/** A download read up to `maxBytes` and no further: never more than the cap is held. */
async function readWithin(
  response: MediaResponse,
  maxBytes: number,
): Promise<Uint8Array | { readonly tooLarge: true; readonly head: Uint8Array; readonly mimeType?: string }> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // What it is said to be, and its first bytes once past the cap: a video's refusal says how to make it fit.
  const mimeType = response.headers.get("content-type") ?? undefined;
  const tooLarge = (head: Uint8Array) => ({ tooLarge: true as const, head, ...(mimeType === undefined ? {} : { mimeType }) });
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Best effort: the body is discarded; one already closed has nothing to cancel.
    await response.body?.cancel().catch(() => undefined);
    return tooLarge(new Uint8Array());
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await reader.cancel().catch(() => undefined);
      const head = joined([...chunks, value]);
      return tooLarge(head.subarray(0, VIDEO_SNIFF_BYTES));
    }
    chunks.push(value);
  }
  return joined(chunks);
}

/** Chunks as one array. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Why an attachment past the channel's cap was skipped: for a video (by the provider's word, or its first bytes), the
 * cap and a hint to trim it, since a shorter clip fits.
 */
function tooLarge(
  handle: InboundMediaHandle,
  policy: MediaPolicy,
  seen: { readonly head?: Uint8Array; readonly mimeType?: string } = {},
): string {
  const said = [handle.mimeType, seen.mimeType]
    .map((type) => type?.toLowerCase().split(";")[0]?.trim())
    .find((type) => type?.startsWith("video/") === true);
  const sniffed =
    seen.head === undefined || seen.head.byteLength === 0 ? undefined : sniffMediaType(seen.head.subarray(0, VIDEO_SNIFF_BYTES));
  const type = sniffed?.startsWith("video/") === true ? sniffed : said;
  // Only where this channel takes a video at all: elsewhere a shorter clip would be refused for its type.
  if (type === undefined || !mediaTypeAllowed(type, policy.mimeTypes)) return "too large";
  return `too large (a video here is at most ${kilobytes(policy.inboundMaxBytes)}): trim it, or send a shorter clip`;
}

/** One attachment kept as an artifact, or why it was not. */
async function takeIn(
  input: MediaIntakeInput,
  handle: InboundMediaHandle,
  index: number,
): Promise<{ readonly artifactId: string; readonly contentType: string; readonly byteSize: number } | string> {
  if (input.allowedIn === undefined) return "the sender is not allowed";
  const policy = input.policy;
  if (policy === undefined || policy.mimeTypes.length === 0) return "this channel takes no attachments";
  if (handle.sizeBytes !== undefined && handle.sizeBytes > policy.inboundMaxBytes) return tooLarge(handle, policy);
  let bytes: Uint8Array;
  if (handle.inline !== undefined) bytes = handle.inline;
  else if (input.instance?.fetchMedia === undefined) return "it could not be downloaded";
  else {
    try {
      const fetched = await input.instance.fetchMedia(handle, {
        maxBytes: policy.inboundMaxBytes,
        signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
      });
      if (fetched instanceof Uint8Array) bytes = fetched;
      else {
        const read = await readWithin(fetched, policy.inboundMaxBytes);
        if ("tooLarge" in read) return tooLarge(handle, policy, read);
        bytes = read;
      }
    } catch {
      return "it could not be downloaded";
    }
  }
  if (bytes.byteLength > policy.inboundMaxBytes) return tooLarge(handle, policy, { head: bytes });
  const contentType = sniffMediaType(bytes);
  if (contentType === undefined || !mediaTypeAllowed(contentType, policy.mimeTypes)) return "not a type this channel takes";
  let record: ArtifactRecord;
  const artifactId = artifactIdOf(input.event, index);
  try {
    record = await input.artifacts.putArtifact({
      artifactId,
      workspaceId: input.allowedIn,
      contentType,
      body: bytes,
      extension: EXTENSIONS[contentType] ?? "bin",
      untrusted: true,
      // Whoever sent it, its bytes are from outside: `attachment`, by its sender.
      label: untrustedLabel("attachment", {
        principal: `member:${input.event.connectionId}:${input.event.externalSenderId}`.slice(0, CONTENT_LABEL_LIMITS.maxPrincipalLength),
        ref: { ref: artifactId, at: input.event.receivedAt },
      }),
    });
  } catch {
    // The message still counts: a store that cannot keep files (no artifacts
    // directory) loses the attachment, not the message.
    return "it could not be stored";
  }
  return { artifactId: record.artifactId, contentType, byteSize: record.byteSize };
}
