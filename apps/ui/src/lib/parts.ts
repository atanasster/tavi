/**
 * A `[part]` an idea's words leave for the reader to fill in: words in single
 * brackets. Brackets that say something else are not one: a Markdown link or
 * image (`[text](url)`, `[text][ref]`, `[ref]: url`), a `[[wiki]]` link, a task
 * box (`[ ]`, `[x]`), anything with no letter in it (`[1]`, `[1-3]`), brackets
 * joined to what comes before them, as code's are (`arr[i]`, `foo[bar]`), one
 * word that is an address (`[https://example.com]`, `[example.com]`, `[fe80::1]`),
 * or anything in code, fenced or between backticks.
 */
const PART = /(?<![[\]\p{L}\p{N}_)])\[(?![xX]\])[^[\]\n]*\p{L}[^[\]\n]*\](?![[\](]|:\s*\S+:\/\/)/gu;

/** A part that is one word with an address's marks: a scheme's `//`, a dot or an `@` between letters, or IPv6's `::`. */
const ADDRESS = /^\[\s*(?:\S*(?:\/\/|[\p{L}\p{N}][.@][\p{L}\p{N}])\S*|[\da-f:]*::[\da-f:]*)\s*\]$/iu;

/** Code: a fence of backticks or tildes, to its end or the text's, a span between runs of backticks on one line, or an indented line. */
const CODE = /(?:^|\n) {0,3}(`{3,}|~{3,})[\s\S]*?(?:\n {0,3}\1|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\2(?!`)|(?:^|\n)(?: {4}|\t)[^\n]*/g;

/** The first `[part]` of `text` at or after `from`, as a selection takes it. */
export function nextPart(text: string, from = 0): { readonly start: number; readonly end: number } | undefined {
  const code = [...text.matchAll(CODE)].map(({ 0: span, index }) => ({ start: index, end: index + span.length }));
  for (const { 0: part, index } of text.matchAll(PART))
    if (index >= from && !ADDRESS.test(part) && !code.some(({ start, end }) => index >= start && index < end))
      return { start: index, end: index + part.length };
  return undefined;
}
