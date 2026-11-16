import type { SubtitleCue } from "@tavi/contracts";

/**
 * A subtitle track read as text: the
 * SubRip FFmpeg writes from any text track, parsed into cues. Markup goes (an
 * italic tag, an ASS override, a font colour): what is left is the words a
 * viewer reads. A track's words are the video's, so they carry its label.
 */

/** The most cues one track gives; past it, the rest are dropped. */
export const MAX_SUBTITLE_CUES = 2_000;

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function seconds(stamp: string): number | undefined {
  const match = TIME.exec(stamp);
  if (match === null) return undefined;
  const [, hours, minutes, secs, millis] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number((millis ?? "0").padEnd(3, "0")) / 1000;
}

/** A cue's text read at most: a hostile track's one huge cue costs no more than this. */
const MAX_CUE_SOURCE = 4_000;

/** Markup a cue's text carries, removed: HTML-like tags, ASS overrides (`{\an8}`), and the line-break escape. */
export function plainCueText(text: string): string {
  // Cut before any pattern runs, and every pattern bounded: no cue text can make the owner wait.
  return text
    .slice(0, MAX_CUE_SOURCE)
    .replace(/\{\\[^}]{0,256}\}/g, "")
    .replace(/<[^>]{0,64}>/g, "")
    .replace(/\\[Nn]/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .slice(0, 1_000);
}

/** SubRip's cues: number, `start --> end`, text lines, a blank line. Malformed blocks are skipped, never guessed. */
export function parseSubRip(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    if (cues.length >= MAX_SUBTITLE_CUES) break;
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [from, to] = (lines[timing] ?? "").split("-->");
    const startSec = seconds(from ?? "");
    const endSec = seconds(to ?? "");
    if (startSec === undefined || endSec === undefined || endSec < startSec) continue;
    const words = plainCueText(lines.slice(timing + 1).join("\n"));
    if (words !== "") cues.push({ startSec, endSec, text: words });
  }
  return cues;
}

/** The cues shown during `[from, to]`. */
export function cuesWithin(cues: readonly SubtitleCue[], from: number, to: number): SubtitleCue[] {
  return cues.filter((cue) => cue.endSec >= from && cue.startSec <= to);
}
