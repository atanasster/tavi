import { useSyncExternalStore } from "react";

/**
 * Which plugin contributions this page paused for sending too much
 * (the flood guard), so Settings → Plugins can
 * say so. Kept for the page's life only: a reload gives a plugin a fresh try.
 */

let flooded: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** `key` is the contribution's `<plugin-id>/<contribution-id>` (`contributionKey`), as Settings keys its rows. */
export function reportFlood(key: string): void {
  if (flooded.has(key)) return;
  flooded = new Set([...flooded, key]);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The paused contributions now. */
export function floodedPlugins(): ReadonlySet<string> {
  return flooded;
}

/** The paused contributions, re-rendering when one is added. */
export function useFloodedPlugins(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, floodedPlugins, floodedPlugins);
}
