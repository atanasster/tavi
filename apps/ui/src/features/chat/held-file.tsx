import { useEffect, useState } from "react";
import type { ArtifactListRow } from "@tavi/contracts";
import { useNearViewport } from "../../hooks/use-near-viewport.js";
import { formatBytes } from "../../lib/format.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { readThumbnail } from "../center/browser-api.js";
import { useWorkspace } from "../shell/Workspace.js";

/** The images the owner serves for a chat's Held files: approved JPEG, PNG and WebP, up to 4 MiB. */
const SHOWN_IMAGE = /^image\/(jpeg|png|webp)$/;
const SHOWN_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Whether the canvas can show this file's picture (the owner serves only approved images). */
export function showsImage(row: ArtifactListRow): boolean {
  return row.reviewState === "approved" && SHOWN_IMAGE.test(row.contentType) && row.byteSize <= SHOWN_IMAGE_MAX_BYTES;
}

/** The types a file is named by in words, and the tag on its tile. */
const KINDS: Readonly<Record<string, { readonly key: UiKey; readonly tag: string }>> = {
  "image/jpeg": { key: "chat.fileKind.jpeg", tag: "JPG" },
  "image/png": { key: "chat.fileKind.png", tag: "PNG" },
  "image/webp": { key: "chat.fileKind.webp", tag: "WEBP" },
  "image/gif": { key: "chat.fileKind.gif", tag: "GIF" },
  "application/pdf": { key: "chat.fileKind.pdf", tag: "PDF" },
  "text/plain": { key: "chat.fileKind.text", tag: "TXT" },
  "text/markdown": { key: "chat.fileKind.markdown", tag: "MD" },
  "text/csv": { key: "chat.fileKind.csv", tag: "CSV" },
  "application/json": { key: "chat.fileKind.json", tag: "JSON" },
};

/** A content type's own part, and its subtype as a tag would read it: "zip", "ms-excel"; "" when it names nothing. */
function typeParts(contentType: string): { readonly type: string; readonly subtype: string } {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const subtype = type.split("/")[1]?.replace(/^(x-|vnd\.)/, "") ?? "";
  return { type, subtype: subtype === "octet-stream" ? "" : subtype };
}

/** What a file is, in words: "JPEG image", "PDF", "ZIP file". */
export function fileKind(contentType: string): string {
  const { type, subtype } = typeParts(contentType);
  const known = KINDS[type];
  if (known !== undefined) return translateNow(known.key);
  return subtype === "" ? translateNow("chat.fileKind.file") : translateNow("chat.fileKind.other", { type: subtype.toUpperCase() });
}

/** The short tag on a file's tile: "JPG", "PDF", "TXT". */
export function fileTag(contentType: string): string {
  const { type, subtype } = typeParts(contentType);
  const known = KINDS[type];
  if (known !== undefined) return known.tag;
  return subtype === "" ? "FILE" : subtype.slice(0, 4).toUpperCase();
}

/** A file's name as a person calls it: its own, else what it is. */
export function fileTitle(row: ArtifactListRow): string {
  return row.fileName ?? fileKind(row.contentType);
}

/** A file's size and type on one line: "142.4 KiB · JPEG image". */
export function fileFacts(row: ArtifactListRow): string {
  return `${formatBytes(row.byteSize)} · ${fileKind(row.contentType)}`;
}

const REVIEW: Readonly<Record<ArtifactListRow["reviewState"], { readonly label: UiKey; readonly tone: string }>> = {
  approved: { label: "chat.fileReview.approved", tone: "badge-ok" },
  pending: { label: "chat.fileReview.pending", tone: "badge-warning" },
  rejected: { label: "chat.fileReview.rejected", tone: "badge-bad" },
};

/** The file's review state as a badge. */
export function ReviewBadge({ state }: { readonly state: ArtifactListRow["reviewState"] }) {
  const t = useT();
  const review = REVIEW[state];
  return <span className={`badge ${review.tone}`}>{t(review.label)}</span>;
}

const images = new Map<string, Promise<string | undefined>>();
/** The most pictures kept in memory: a new capture is a new id, so one never goes stale. */
const IMAGES_MAX = 48;

/** A shown image's `data:` URL, read once per workspace and artifact; a failed read is not kept. */
function cachedImage(read: () => ReturnType<typeof readThumbnail>, key: string): Promise<string | undefined> {
  const held = images.get(key);
  if (held !== undefined) return held;
  const reading = read().then((outcome) => {
    if (!outcome.ok) images.delete(key);
    return outcome.ok ? outcome.value : undefined;
  });
  images.set(key, reading);
  while (images.size > IMAGES_MAX) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) break;
    images.delete(oldest);
  }
  return reading;
}

/**
 * A held file's picture: an approved image, read when it first comes near the viewport (at once where there is no
 * `IntersectionObserver`); any other file, or one that cannot be read, is a tile with its type.
 */
export function HeldFilePicture({
  row,
  alt,
  className,
}: {
  readonly row: ArtifactListRow;
  readonly alt: string;
  readonly className: string;
}) {
  const { client, workspaceId } = useWorkspace();
  const shown = showsImage(row);
  const [src, setSrc] = useState<string>();
  const [near, frame] = useNearViewport<HTMLDivElement>(shown);
  useEffect(() => {
    setSrc(undefined);
    if (!shown || !near) return;
    let alive = true;
    void cachedImage(() => readThumbnail(client, workspaceId, row.artifactId), `${workspaceId}\u0000${row.artifactId}`).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [client, workspaceId, row.artifactId, shown, near]);
  return (
    <div className={className} ref={frame}>
      {src === undefined ? (
        <span className="held-file-tag" aria-hidden="true">
          {fileTag(row.contentType)}
        </span>
      ) : (
        <img src={src} alt={alt} />
      )}
    </div>
  );
}
