import { isAudioContainer, sniffAudioContainer, sniffVideoContainer, VIDEO_SNIFF_BYTES, type MediaContainer } from "@tavi/contracts";

/**
 * The decoder's sniff: the
 * contracts' one rule for what a video is from its bytes, shared with the
 * channels' intake, and the demuxer each container fixes, so FFmpeg never
 * probes for one.
 */

export const sniffVideo = sniffVideoContainer;

/** How many bytes of a file `sniffVideo` needs. */
export const SNIFF_BYTES = VIDEO_SNIFF_BYTES;

/** A run's container by the rule of the kind it was opened as: a video's, or an audio file's. */
export function sniffMedia(head: Uint8Array, as: MediaContainer): MediaContainer | undefined {
  return isAudioContainer(as) ? sniffAudioContainer(head) : sniffVideoContainer(head);
}

/** The demuxer FFmpeg is told to use for a container (`-f`): it never probes for one. */
export function demuxerOf(container: MediaContainer): "mov" | "matroska" | "gif" | "ogg" | "mp3" | "wav" | "aac" {
  if (container === "webm" || container === "matroska") return "matroska";
  if (container === "gif") return "gif";
  if (container === "ogg" || container === "mp3" || container === "wav" || container === "aac") return container;
  return "mov";
}
