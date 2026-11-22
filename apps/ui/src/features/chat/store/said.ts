import type { MessageParams, Translate } from "@tavi/contracts/i18n";
import { errorMessage } from "@tavi/contracts/util";

import { translateNow } from "../../../lib/i18n.js";
import type { UiKey } from "../../../locales/en.js";

/** A message the store wrote itself: its key and values, put into words where it is shown. */
export interface SaidKey {
  readonly key: UiKey;
  readonly params?: SaidParams;
}
export type SaidParams = { readonly [name: string]: string | number | SaidKey };

/**
 * Words the store keeps to show: its own message as a key, so a change of
 * language reaches it, or text as the owner sent it.
 */
export type Said = string | SaidKey;

export function said(key: UiKey, params?: SaidParams): SaidKey {
  return params === undefined ? { key } : { key, params };
}

/** `words` in the language `t` speaks. */
export function spoken(words: Said, t: Translate<UiKey>): string {
  if (typeof words === "string") return words;
  if (words.params === undefined) return t(words.key);
  const params: { [name: string]: string | number } = {};
  for (const [name, value] of Object.entries(words.params)) params[name] = typeof value === "object" ? spoken(value, t) : value;
  return t(words.key, params satisfies MessageParams);
}

/** A failure in the store's own words, thrown to the catch that keeps it. */
export class SaidError extends Error {
  readonly said: SaidKey;
  constructor(words: SaidKey) {
    super(spoken(words, translateNow));
    this.said = words;
  }
}

/** What a caught failure says: the store's own message as its key, any other error's message as it is. */
export function saidOf(error: unknown): Said {
  return error instanceof SaidError ? error.said : errorMessage(error);
}

/** A raw response's refusal: the owner's message as it sent it, else `fallback`. */
export function refusedAs(response: { readonly error?: { readonly message: string } | undefined }, fallback: SaidKey): Said {
  return response.error?.message ?? fallback;
}
