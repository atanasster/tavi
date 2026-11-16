/**
 * Text cleared of terminal escape sequences and control characters: what a
 * terminal may print, and the first pass of cleaning any text a third party
 * wrote (an MCP server's descriptions, instructions and results).
 */

const ESCAPE_SEQUENCE = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC: a title, a hyperlink, the clipboard
    "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI: colours and cursor movement
    "\\u001b[@-_]", // any other escape
    "\\u009b[0-?]*[ -/]*[@-~]", // CSI in its one-byte C1 form
  ].join("|"),
  "g",
);
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * `text` without escape sequences (OSC, CSI, any other ESC) and without C0/C1
 * control characters, newline and tab kept; `\r\n` and a lone `\r` become `\n`.
 */
export function withoutControls(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

/**
 * Text as the terminal may print it: model and tool output can be steered by
 * content the model read, so no escape sequence (a title, the clipboard, a
 * cursor move) and no control character reaches the screen. Tabs become spaces,
 * so widths are what they seem.
 */
export function printable(text: string): string {
  return withoutControls(text.replace(/\t/g, "    "));
}

/**
 * C0 and C1 controls but newline and tab, DEL, the line and paragraph
 * separators, every format character (bidi, zero-width, tags) and every
 * default-ignorable one (variation selectors, the grapheme joiner, Hangul and
 * Mongolian fillers): none of them is seen, and each can hide or reorder text.
 */
const HIDDEN_CHARACTER = /^[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
/** A pictograph: what an emoji presentation selector may follow, and what a joiner joins. */
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
/** A skin-tone modifier: a joiner may follow one (a family of toned people). */
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
/** A keycap's base (`1️⃣`): a selector after one is its own only before the keycap mark. */
const KEYCAP_BASE = /^[0-9#*]$/;
const COMBINING_KEYCAP = 0x20e3;
const ARABIC_LETTER = /^\p{Script=Arabic}$/u;
const VARIATION_TEXT = 0xfe0e;
const VARIATION_EMOJI = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;
const ZERO_WIDTH_NON_JOINER = 0x200c;
const BLACK_FLAG = 0x1f3f4;
const TAG_CANCEL = 0xe007f;
const isTag = (point: number): boolean => point >= 0xe0020 && point <= 0xe007e;
/** The subdivision flags Unicode recommends (RGI): England, Scotland, Wales. Any other tag run is a hiding place. */
const RGI_SUBDIVISIONS: ReadonlySet<string> = new Set(["gbeng", "gbsct", "gbwls"]);

function mark(character: string): string {
  const point = character.codePointAt(0)!;
  return point === 0x1b ? "⟨ESC⟩" : `⟨U+${point.toString(16).toUpperCase().padStart(4, "0")}⟩`;
}

/**
 * Whether the hidden character at `index` is one an emoji or a script needs,
 * and so is no hiding place: one presentation selector right after a
 * pictograph, or after a keycap's base before its keycap mark; a joiner
 * between two pictographs (a family, a flame heart); a non-joiner between two
 * Arabic-script letters.
 */
function needed(points: readonly string[], index: number): boolean {
  const point = points[index]!.codePointAt(0)!;
  const before = points[index - 1];
  const after = points[index + 1];
  if (point === VARIATION_TEXT || point === VARIATION_EMOJI) {
    if (before === undefined) return false;
    return PICTOGRAPH.test(before) || (KEYCAP_BASE.test(before) && after?.codePointAt(0) === COMBINING_KEYCAP);
  }
  if (point === ZERO_WIDTH_JOINER) {
    const beforeBase = before?.codePointAt(0) === VARIATION_EMOJI ? points[index - 2] : before;
    const joined = beforeBase !== undefined && (PICTOGRAPH.test(beforeBase) || SKIN_TONE.test(beforeBase));
    return joined && after !== undefined && PICTOGRAPH.test(after);
  }
  if (point === ZERO_WIDTH_NON_JOINER)
    return before !== undefined && after !== undefined && ARABIC_LETTER.test(before) && ARABIC_LETTER.test(after);
  return false;
}

/**
 * What a card may show of text a model, a page or a sender could have
 * written. A terminal control (C0 and C1 but newline and tab, DEL, and so
 * every escape sequence's ESC), a bidi override or isolate, and a zero-width,
 * variation-selector or other invisible character can make a card read as
 * something other than what is approved: each is shown as a visible marker
 * instead (`⟨ESC⟩`, `⟨U+202E⟩`), so what was hidden is noticed. What an emoji
 * or a script needs is left alone (`needed`, and the three recommended
 * subdivision flags' tag sequences). `\r\n` is a newline.
 */
export function displaySafe(text: string): string {
  const points = Array.from(text.replace(/\r\n/g, "\n"));
  let shown = "";
  for (let index = 0; index < points.length; index += 1) {
    const character = points[index]!;
    if (character.codePointAt(0) === BLACK_FLAG) {
      // A recommended subdivision flag: its tags, then CANCEL TAG, are the flag's own.
      let end = index + 1;
      while (end < points.length && isTag(points[end]!.codePointAt(0)!)) end += 1;
      const tagged = points
        .slice(index + 1, end)
        .map((tag) => String.fromCodePoint(tag.codePointAt(0)! - 0xe0000))
        .join("");
      if (points[end]?.codePointAt(0) === TAG_CANCEL && RGI_SUBDIVISIONS.has(tagged)) {
        shown += points.slice(index, end + 1).join("");
        index = end;
        continue;
      }
    }
    shown += HIDDEN_CHARACTER.test(character) && !needed(points, index) ? mark(character) : character;
  }
  // A long run of blank lines pushes what follows off a card: it is shown as one mark.
  return shown.replace(/\n(?:[ \t]*\n){3,}/g, (run) => `\n\n⟨${String(run.split("\n").length - 2)} blank lines⟩\n`);
}

/** Whether `displaySafe` would mark anything in `text`. */
export function hasHiddenCharacters(text: string): boolean {
  return displaySafe(text) !== text.replace(/\r\n/g, "\n");
}
