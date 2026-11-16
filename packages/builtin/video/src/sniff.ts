import { sniffVideoContainer, VIDEO_SNIFF_BYTES, type VideoContainer } from "@tavi/contracts";

/**
 * The decoder's sniff: the
 * contracts' one rule for what a video is from its bytes, shared with the
 * channels' intake, and the demuxer each container fixes, so FFmpeg never
 * probes for one.
 */

export const sniffVideo = sniffVideoContainer;

/** How many bytes of a file `sniffVideo` needs. */
export const SNIFF_BYTES = VIDEO_SNIFF_BYTES;

/** The demuxer FFmpeg is told to use for a container (`-f`): it never probes for one. */
export function demuxerOf(container: VideoContainer): "mov" | "matroska" | "gif" {
  if (container === "webm" || container === "matroska") return "matroska";
  if (container === "gif") return "gif";
  return "mov";
}
