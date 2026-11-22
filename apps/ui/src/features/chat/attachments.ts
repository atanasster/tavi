import {
  ATTACHMENT_UPLOAD_CHUNK_CHARS,
  ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES,
  ATTACHMENT_UPLOAD_PDF_MAX_BYTES,
  ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES,
  IPC_MAX_PROMPT_CHARS,
  sniffAudioContainer,
  type ArtifactUploadAnswer,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, type SettingsClient } from "../../lib/ipc.js";

interface TextAttachment {
  readonly kind?: "text";
  readonly name: string;
  readonly text: string;
}
/**
 * A PDF, a video, a GIF, a photo or an audio file:
 * uploaded when the message is sent, and named by it, never inlined. The file
 * itself is kept, and read a slice at a time as it is sent, never whole.
 */
export interface UploadAttachment {
  readonly kind: "upload";
  readonly media: "pdf" | "video" | "gif" | "image" | "audio";
  readonly name: string;
  readonly file: Blob;
}
export type Attachment = TextAttachment | UploadAttachment;
export const MAX_ATTACHMENT_BYTES = 48 * 1024;
export const MAX_ATTACHMENTS = 5;
const TEXT_FILE_ACCEPT = ".txt,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sh,.sql,.log,.rs,.go,.java,.c,.h,.cpp";
const VIDEO_FILE_ACCEPT = ".mp4,.mov,.m4v,.webm,.gif";
const IMAGE_FILE_ACCEPT = ".png,.jpg,.jpeg";
/** The audio `audio.transcribe` reads: Ogg (Opus, a voice note), MP3, M4A, WAV and raw AAC. */
const AUDIO_FILE_ACCEPT = ".ogg,.opus,.mp3,.m4a,.wav,.aac";
const AUDIO_TYPES = ["audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/aac"];
export const FILE_ACCEPT = `${TEXT_FILE_ACCEPT},.pdf,${VIDEO_FILE_ACCEPT},${IMAGE_FILE_ACCEPT},${AUDIO_FILE_ACCEPT}`;
/** What a message of files alone says: the owner takes no blank prompt. */
export const FILES_ONLY_PROMPT = "(see the attached file)";

const isUpload = (attachment: Attachment): attachment is UploadAttachment => attachment.kind === "upload";

/** What a file's first bytes say it is, of the kinds the owner takes by upload: the owner checks again. */
function headIs(media: UploadAttachment["media"], head: Uint8Array): boolean {
  const ascii = (offset: number, text: string): boolean =>
    new TextDecoder("latin1").decode(head.subarray(offset, offset + text.length)) === text;
  if (media === "pdf") return ascii(0, "%PDF-");
  if (media === "gif") return ascii(0, "GIF87a") || ascii(0, "GIF89a");
  // The owner's own rule, so what the browser takes as audio is what the owner keeps; an `.m4a` some recorders write
  // under a video brand (`mp42`, `isom`) is still an ISO file the owner takes, as an MP4.
  if (media === "audio") return sniffAudioContainer(head) !== undefined || ascii(4, "ftyp");
  if (media === "image")
    return (
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => head[index] === byte) ||
      (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    );
  // An ISO media file (MP4, MOV, M4V), or Matroska's EBML header (WebM).
  return ascii(4, "ftyp") || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);
}

export async function readAttachment(file: File): Promise<Attachment> {
  const extension = `.${file.name.split(".").at(-1)?.toLowerCase()}`;
  const media: UploadAttachment["media"] | undefined =
    extension === ".pdf" || file.type === "application/pdf"
      ? "pdf"
      : extension === ".gif" || file.type === "image/gif"
        ? "gif"
        : IMAGE_FILE_ACCEPT.split(",").includes(extension) || ["image/png", "image/jpeg"].includes(file.type)
          ? "image"
          : AUDIO_FILE_ACCEPT.split(",").includes(extension) || AUDIO_TYPES.includes(file.type)
            ? "audio"
            : // Only the containers the owner takes: a Matroska or 3GP file is not attached as a video it would refuse.
              VIDEO_FILE_ACCEPT.split(",").includes(extension) || ["video/mp4", "video/quicktime", "video/webm"].includes(file.type)
              ? "video"
              : undefined;
  if (media !== undefined) {
    const cap =
      media === "pdf"
        ? ATTACHMENT_UPLOAD_PDF_MAX_BYTES
        : media === "image"
          ? ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES
          : ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES;
    if (file.size > cap)
      throw new Error(
        media === "image"
          ? translateNow("chat.attach.tooBig.image", { name: file.name, size: String(cap / 1_000_000) })
          : translateNow(
              media === "pdf" ? "chat.attach.tooBig.pdf" : media === "audio" ? "chat.attach.tooBig.audio" : "chat.attach.tooBig.video",
              { name: file.name, size: String(cap / 1024 / 1024) },
            ),
      );
    // Only its head is read now: the rest is read a slice at a time as it is sent.
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!headIs(media, head))
      throw new Error(
        translateNow(
          (
            {
              pdf: "chat.attach.notKind.pdf",
              gif: "chat.attach.notKind.gif",
              image: "chat.attach.notKind.image",
              video: "chat.attach.notKind.video",
              audio: "chat.attach.notKind.audio",
            } as const
          )[media],
          { name: file.name },
        ),
      );
    return { kind: "upload", media, name: file.name, file };
  }
  if (!TEXT_FILE_ACCEPT.split(",").includes(extension) && !file.type.startsWith("text/"))
    throw new Error(translateNow("chat.attach.unsupported", { name: file.name }));
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(translateNow("chat.attach.tooBig.text", { name: file.name }));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  if (text.includes("\0")) throw new Error(translateNow("chat.attach.binary", { name: file.name }));
  return { name: file.name, text };
}

/** A code fence longer than any run of backticks in `text`, so the file's own cannot end it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The prompt with the text files inlined, each as its lines in a fence (shown
 * as a block in the message, never one escaped string); PDFs, photos, videos, GIFs
 * and audio go by upload.
 */
export function composePrompt(prompt: string, attachments: readonly Attachment[]): string {
  const texts = attachments.filter((file): file is TextAttachment => !isUpload(file));
  const result = [
    prompt.trim(),
    ...texts.map((file) => {
      const fence = fenceFor(file.text);
      return `Attached file ${JSON.stringify(file.name)} (reference content):\n${fence}\n${file.text.replace(/\n$/, "")}\n${fence}`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (result.length > IPC_MAX_PROMPT_CHARS) throw new Error(translateNow("chat.attach.tooLong"));
  return result;
}

/** A text file a prompt carries inline, as `composePrompt` wrote it. */
export interface InlinedFile {
  readonly name: string;
  readonly text: string;
}

/** One inlined file's block, at the start of what is left of the prompt: its name (JSON), its fence, its lines. */
const INLINED_FILE = /^Attached file ("(?:[^"\\\n]|\\.)*") \(reference content\):\n(`{3,})\n([\s\S]*?)\n\2(?:\n\n|$)/;

/**
 * `prompt` as the person wrote it and the text files `composePrompt` inlined
 * after it, so a message shows them as files rather than their whole text.
 * Only the blocks it writes, at the prompt's end and each whole, are read as
 * files: anything else is left in the text, as typed.
 */
export function inlinedFilesOf(prompt: string): { readonly text: string; readonly files: readonly InlinedFile[] } {
  const start = prompt.startsWith("Attached file ") ? 0 : prompt.indexOf("\n\nAttached file ");
  if (start < 0) return { text: prompt, files: [] };
  let rest = prompt.slice(start === 0 ? 0 : start + 2);
  const files: InlinedFile[] = [];
  while (rest !== "") {
    const match = INLINED_FILE.exec(rest);
    const name = match === null ? undefined : nameOf(match[1] ?? "");
    if (match === null || name === undefined) return { text: prompt, files: [] };
    files.push({ name, text: match[3] ?? "" });
    rest = rest.slice(match[0].length);
  }
  return { text: prompt.slice(0, start), files };
}

function nameOf(json: string): string | undefined {
  try {
    const name: unknown = JSON.parse(json);
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

export const uploadsOf = (attachments: readonly Attachment[]): readonly UploadAttachment[] => attachments.filter(isUpload);

/** The upload chunk's bytes: their base64 fits `ATTACHMENT_UPLOAD_CHUNK_CHARS`. */
const CHUNK_BYTES = (ATTACHMENT_UPLOAD_CHUNK_CHARS / 4) * 3;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * `file` sent with `artifacts upload`, chunk by chunk, each read from the file
 * as it is sent (a 50 MB video is never in memory whole): its artifact id, or
 * why the owner refused it.
 */
export async function uploadFile(client: SettingsClient, workspaceId: string, file: UploadAttachment, uploadId: string): Promise<string> {
  const size = file.file.size;
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    let chunk: Uint8Array;
    try {
      chunk = new Uint8Array(await file.file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    } catch {
      // The file is read as it is sent: one moved, deleted or changed since it was attached cannot be.
      throw new Error(translateNow("chat.attach.moved", { name: file.name }));
    }
    const answer = await ask<ArtifactUploadAnswer>(
      client,
      "artifacts",
      { action: "upload", workspaceId, uploadId, name: file.name, size, offset, data: base64(chunk) },
      { timeoutMs: 60_000 },
    );
    if (!answer.ok) throw new Error(`${file.name}: ${answer.message}`);
    if (answer.value.attachment !== undefined) return answer.value.attachment.artifactId;
  }
  throw new Error(translateNow("chat.attach.unfinished", { name: file.name }));
}
