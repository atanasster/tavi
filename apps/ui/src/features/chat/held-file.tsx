import { useEffect, useRef, useState } from "react";
import type { ArtifactListRow } from "@tavi/contracts";
import { formatBytes } from "../../lib/format.js";
import { readThumbnail } from "../center/browser-api.js";
import { useWorkspace } from "../shell/Workspace.js";

/** The images the owner serves for a chat's Held files: approved JPEG, PNG and WebP, up to 4 MiB. */
const SHOWN_IMAGE = /^image\/(jpeg|png|webp)$/;
const SHOWN_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Whether the canvas can show this file's picture (the owner serves only approved images). */
export function showsImage(row: ArtifactListRow): boolean {
  return row.reviewState === "approved" && SHOWN_IMAGE.test(row.contentType) && row.byteSize <= SHOWN_IMAGE_MAX_BYTES;
}

const KINDS: Readonly<Record<string, string>> = {
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/webp": "WebP image",
  "image/gif": "GIF image",
  "application/pdf": "PDF",
  "text/plain": "Text file",
  "text/markdown": "Markdown file",
  "text/csv": "CSV file",
  "application/json": "JSON file",
};

/** What a file is, in words: "JPEG image", "PDF", "ZIP file". */
export function fileKind(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = KINDS[type];
  if (known !== undefined) return known;
  const subtype = type.split("/")[1]?.replace(/^(x-|vnd\.)/, "") ?? "";
  return subtype === "" || subtype === "octet-stream" ? "File" : `${subtype.toUpperCase()} file`;
}

/** The short tag on a file's tile: "JPG", "PDF", "TXT". */
export function fileTag(contentType: string): string {
  const kind = fileKind(contentType);
  if (kind === "File") return "FILE";
  return (kind.split(" ")[0] ?? "FILE").replace("JPEG", "JPG").replace("Text", "TXT").replace("Markdown", "MD").slice(0, 4).toUpperCase();
}

/** A file's name as a person calls it: its own, else what it is. */
export function fileTitle(row: ArtifactListRow): string {
  return row.fileName ?? fileKind(row.contentType);
}

/** A file's size and type on one line: "142.4 KiB · JPEG image". */
export function fileFacts(row: ArtifactListRow): string {
  return `${formatBytes(row.byteSize)} · ${fileKind(row.contentType)}`;
}

const REVIEW: Readonly<Record<ArtifactListRow["reviewState"], { readonly label: string; readonly tone: string }>> = {
  approved: { label: "Approved", tone: "badge-ok" },
  pending: { label: "Waiting for review", tone: "badge-warning" },
  rejected: { label: "Rejected", tone: "badge-bad" },
};

/** The file's review state as a badge. */
export function ReviewBadge({ state }: { readonly state: ArtifactListRow["reviewState"] }) {
  const review = REVIEW[state];
  return <span className={`badge ${review.tone}`}>{review.label}</span>;
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
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown || near || frame.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [shown, near]);
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
