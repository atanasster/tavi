import { useState } from "react";

import type { Outcome } from "./ipc.js";

/**
 * Lists read a page at a time: pages merged with each item once, a list's
 * pages as held, and the first page read again live without losing the older
 * pages the reader loaded below it.
 */

/** Pages merged in order, each item once: a later copy replaces an earlier one in its place. */
export function mergeBy<T, K>(pages: readonly (readonly T[] | undefined)[], keyOf: (item: T) => K): T[] {
  const merged = new Map<K, T>();
  for (const page of pages) for (const item of page ?? []) merged.set(keyOf(item), item);
  return [...merged.values()];
}

/** A list as loaded: every page read so far, and where the next begins. */
export interface Paged<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
  /** Pages read, so a live refresh knows whether older ones are held below the first. */
  readonly pages: number;
}

/** One page as the owner answers it. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

/**
 * A live refresh of the first page over what is held. With only the first
 * page loaded, it is replaced. With older pages below it, the fresh page is
 * laid over them — items it carries are its own, older items (by `dateOf`,
 * before its last) are kept — so a reader who loaded last week does not lose
 * it to something that happened today.
 */
export function refreshFirstPage<T>(
  held: Paged<T> | undefined,
  page: Page<T>,
  keyOf: (item: T) => string,
  dateOf: (item: T) => string,
): Paged<T> {
  if (held === undefined || held.pages <= 1) return { items: page.items, nextCursor: page.nextCursor, pages: 1 };
  const fresh = new Set(page.items.map(keyOf));
  const last = page.items.at(-1);
  const oldest = last === undefined ? undefined : dateOf(last);
  const older = held.items.filter((item) => !fresh.has(keyOf(item)) && (oldest === undefined || dateOf(item) < oldest));
  return { items: [...page.items, ...older], nextCursor: held.nextCursor, pages: held.pages };
}

/** The next page below what is held, each item once. */
export function appendPage<T>(held: Paged<T> | undefined, page: Page<T>, keyOf: (item: T) => string): Paged<T> {
  return { items: mergeBy([held?.items, page.items], keyOf), nextCursor: page.nextCursor, pages: (held?.pages ?? 1) + 1 };
}

/**
 * A list's "Load older": one page read at a time (`busy` meanwhile), from the
 * cursor the held pages end at. Its answer is dropped when a newer first-page
 * read began meanwhile (`generation` moved); otherwise the page goes to
 * `onPage`, or its refusal to `onFailure`.
 */
export function useOlderPage(generation: { readonly current: number }): {
  readonly busy: boolean;
  readonly load: <T>(
    cursor: string | undefined,
    read: (cursor: string) => Promise<Outcome<T>>,
    onPage: (page: T) => void,
    onFailure: (message: string) => void,
  ) => void;
} {
  const [busy, setBusy] = useState(false);
  const load = <T>(
    cursor: string | undefined,
    read: (cursor: string) => Promise<Outcome<T>>,
    onPage: (page: T) => void,
    onFailure: (message: string) => void,
  ): void => {
    if (cursor === undefined || busy) return;
    const current = generation.current;
    setBusy(true);
    void read(cursor).then((outcome) => {
      setBusy(false);
      if (current !== generation.current) return;
      if (outcome.ok) onPage(outcome.value);
      else onFailure(outcome.message);
    });
  };
  return { busy, load };
}
