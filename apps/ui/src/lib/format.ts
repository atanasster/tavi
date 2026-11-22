import { formatNumber } from "@tavi/contracts/i18n";
import { clip } from "@tavi/contracts/util";

import { currentLocale, translateNow } from "./i18n.js";

/**
 * The canvas's words for numbers and cut text, said the same way on every
 * surface (a count with its noun, a clipped string and an error's message are
 * `@tavi/contracts/util`'s `plural`, `clip` and `errorMessage`; days, times and
 * spans are `time.ts`'s).
 */

/**
 * `value` with `digits` decimals, as `toFixed` rounds it, written with the
 * page's language's decimal mark: "1.5" in English, "1,5" in Bulgarian.
 */
export function decimal(value: number, digits = 1): string {
  const fixed = value.toFixed(digits);
  const mark = formatNumber(1.5, currentLocale()).charAt(1);
  return mark === "." ? fixed : fixed.replace(".", mark);
}

/** Bytes as bytes under 1 KiB, else KiB (or MiB from 1 MiB) with one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return translateNow("common.bytes.mib", { size: decimal(bytes / (1024 * 1024)) });
  if (bytes >= 1024) return translateNow("common.bytes.kib", { size: decimal(bytes / 1024) });
  // The count as written: a plain "1000", never grouped.
  return translateNow("common.bytes.bytes", { count: bytes, size: String(bytes) });
}

/**
 * A count for display, in the page's language: "20,000" in English, "20 000"
 * in Bulgarian. The page's language, never the browser's: the same page must
 * not write one count two ways on two machines.
 */
export const formatCount = (value: number): string => formatNumber(value, currentLocale());

/** A token count as a picker shows it: `1M`, `128K`, `4096`. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000 && count % 100_000 === 0) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000 && count % 100 === 0) return `${(count / 1_000).toFixed(count % 1_000 === 0 ? 0 : 1)}K`;
  return formatCount(count);
}

/** A text's first line, trimmed and clipped: what a session list or a title shows of a prompt. */
export const firstLine = (text: string, max = 80): string => clip(text.split("\n", 1)[0]?.trim() ?? "", max);

/** A URL's host ("api.example.com:8443"), or `fallback` — the text as given — when there is none to parse. */
export function hostOf(url: string | undefined, fallback = url ?? ""): string {
  if (url === undefined) return fallback;
  try {
    return new URL(url).host;
  } catch {
    return fallback;
  }
}

/** An archived artifact's metadata in one line: "text/plain, 120 bytes, pending". */
export const artifactMeta = (row: { readonly contentType: string; readonly byteSize: number; readonly reviewState: string }): string =>
  translateNow("common.artifact.meta", {
    count: row.byteSize,
    contentType: row.contentType,
    size: String(row.byteSize),
    state: row.reviewState,
  });
