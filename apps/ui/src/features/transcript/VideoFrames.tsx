import { isRecord } from "@tavi/contracts/util";

import { usePreviewImage } from "./FillReview.js";

/**
 * A video tool's previews on its card:
 * the contact sheet, the stills with their times, and pose overlays with
 * their rep, read through the preview rule as a PDF's pages are.
 */

export interface VideoPreview {
  readonly artifactId: string;
  readonly caption: string;
  /** A contact sheet is wide: it takes the card's width. */
  readonly wide: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const seconds = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} s` : "");

/** The previews a `video.frames`, `video.view` or `video.pose` result names: its sheet, its stills, its overlays; at most 12. */
export function videoPreviewsOf(output: unknown): readonly VideoPreview[] {
  const result = record(output);
  if (result === undefined) return [];
  const previews: VideoPreview[] = [];
  const sheet = record(result["sheet"]);
  if (typeof sheet?.["artifactId"] === "string") previews.push({ artifactId: sheet["artifactId"], caption: "Contact sheet", wide: true });
  for (const entry of list(result["frames"])) {
    const frame = record(entry);
    if (typeof frame?.["artifactId"] === "string")
      previews.push({
        artifactId: frame["artifactId"],
        caption: seconds(frame["timeSec"]) === "" ? "Frame" : `Frame at ${seconds(frame["timeSec"])}`,
        wide: false,
      });
  }
  for (const [index, entry] of list(result["reps"]).entries()) {
    const rep = record(entry);
    if (typeof rep?.["overlayArtifactId"] === "string")
      previews.push({
        artifactId: rep["overlayArtifactId"],
        caption: `Rep ${String(index + 1)}${seconds(rep["bottomSec"]) === "" ? "" : ` at ${seconds(rep["bottomSec"])}`}`,
        wide: false,
      });
  }
  return previews.slice(0, 12);
}

function VideoFrame({ preview }: { readonly preview: VideoPreview }) {
  const src = usePreviewImage(preview.artifactId);
  return (
    <figure className={preview.wide ? "video-frame video-frame-wide" : "video-frame"}>
      {src === undefined ? <div className="video-frame-empty" aria-hidden="true" /> : <img src={src} alt={preview.caption} />}
      <figcaption className="meta-sm">{preview.caption}</figcaption>
    </figure>
  );
}

/** A completed video call's previews, beside its payloads. */
export function VideoFrames({ output }: { readonly output: unknown }) {
  const previews = videoPreviewsOf(output);
  if (previews.length === 0) return null;
  return (
    <div className="video-frames">
      {previews.map((preview) => (
        <VideoFrame key={preview.artifactId} preview={preview} />
      ))}
    </div>
  );
}
