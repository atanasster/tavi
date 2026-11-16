import { useEffect, useRef, useState } from "react";

import { PHONE_QUERY } from "../lib/breakpoints.js";
import { copyText } from "../lib/clipboard.js";

/**
 * A reload or a close while `dirty` asks first: what an editor can protect
 * from inside the page (an in-app view switch unmounts it, and the shell
 * offers no hook to intercept that).
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Engines that ignore `preventDefault` honor this instead.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
}

/**
 * A copy button's check: on once the browser allowed the copy, and off again
 * after two seconds. `said` hears how the copy went before the check turns;
 * `reset` (with `failedMs`, how long a refusal stays) clears what it said.
 */
export function useCopied(reset?: { readonly onReset: () => void; readonly failedMs: number }): {
  readonly copied: boolean;
  readonly copy: (text: string, said?: (ok: boolean) => void) => void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string, said?: (ok: boolean) => void): void => {
    void copyText(text).then((ok) => {
      said?.(ok);
      setCopied(ok);
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => {
          setCopied(false);
          reset?.onReset();
        },
        ok ? 2000 : (reset?.failedMs ?? 2000),
      );
    });
  };
  return { copied, copy };
}

/** How long typing rests before the search is asked of the owner. */
const SEARCH_DEBOUNCE_MS = 250;

/** The search, asked of the owner once typing rests (`SEARCH_DEBOUNCE_MS`), trimmed. */
export function useSearchQuery(search: string): string {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  return query;
}

const phoneQuery = (): MediaQueryList | undefined =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : undefined;

/** Whether the page is laid out for a phone (`PHONE_QUERY`) right now. */
export function isPhone(): boolean {
  return phoneQuery()?.matches === true;
}

/** Whether the page is laid out for a phone (`PHONE_QUERY`), followed as the window changes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const query = phoneQuery();
    if (query === undefined) return;
    const changed = (): void => setPhone(query.matches);
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  return phone;
}
