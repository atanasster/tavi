import { useEffect, useRef } from "react";

import { CHAT_PANEL_LABELS, CHAT_PANEL_TABS, type ChatPanelTab } from "../chat-panel/tabs.js";

/**
 * The keyboard map, and why it is layered.
 *
 * A browser page cannot reliably own `Cmd+K`, `Cmd+Shift+O`, `Cmd+Shift+M` or
 * `Cmd+.` — they are the host's (find, bookmarks, mute, settings/stop) and
 * `preventDefault` does not reliably win. So the map is in three tiers, and
 * the page promises only what it can keep:
 *
 * - **primary** — conflict-free, always bound: `Esc`, and the two deliberately
 *   awkward approval chords. Approve is never a bare key and `Enter` never
 *   approves.
 * - **bound** — bound with `preventDefault`, and if the browser wins the reader
 *   still has visible controls: `Cmd+K`, `Cmd+/`, `Cmd+Shift+S`, and the chat
 *   panel's `Cmd+Shift+.` and `Cmd+Alt+1…5`.
 * - **sheet** — never bound at all, offered as a button in the `Cmd+/` sheet,
 *   so it is discoverable without being promised.
 */

type KeyTier = "primary" | "bound" | "sheet";

/** One chord, as it is matched and as it is shown. */
export interface KeyBinding {
  /** What this does; the name of the action in the sheet. */
  readonly action: KeyAction;
  readonly label: string;
  /** How it is written for a reader; `Cmd` is shown as `⌘` on Apple platforms by the sheet. */
  readonly chord: string;
  readonly tier: KeyTier;
  /** What a `keydown` must carry to be this chord; absent for a `sheet` entry, which is never matched. */
  readonly match?: {
    readonly key: string;
    /**
     * The physical key, matched instead of `key` where Shift or Alt changes
     * the character a layout types (Shift+. is ">", Alt+1 is "¡" on a Mac).
     */
    readonly code?: string;
    readonly meta?: true;
    readonly alt?: true;
    readonly shift?: true;
  };
}

export type KeyAction =
  | "stop"
  | "approve"
  | "reject"
  | "help"
  | "sidebar"
  | "panel"
  | `panel-${ChatPanelTab}`
  | "newTask"
  | "settings"
  | "models"
  | "search";

export const KEY_MAP: readonly KeyBinding[] = [
  { action: "search", label: "Search chats", chord: "Cmd+K", tier: "bound", match: { key: "k", meta: true } },
  { action: "stop", label: "Stop the running turn", chord: "Esc", tier: "primary", match: { key: "Escape" } },
  {
    action: "approve",
    label: "Allow the waiting round (its first button)",
    chord: "Cmd+Alt+Enter",
    tier: "primary",
    match: { key: "Enter", meta: true, alt: true },
  },
  {
    action: "reject",
    label: "Deny the waiting round",
    chord: "Cmd+Alt+Backspace",
    tier: "primary",
    match: { key: "Backspace", meta: true, alt: true },
  },
  { action: "help", label: "Show this sheet", chord: "Cmd+/", tier: "bound", match: { key: "/", meta: true } },
  { action: "sidebar", label: "Show or hide the chats", chord: "Cmd+Shift+S", tier: "bound", match: { key: "s", meta: true, shift: true } },
  {
    action: "panel",
    label: "Show or hide this chat's panel",
    chord: "Cmd+Shift+.",
    tier: "bound",
    match: { key: ".", code: "Period", meta: true, shift: true },
  },
  // Cmd+Alt, not Cmd+Shift: macOS keeps Cmd+Shift+3, 4 and 5 for screenshots.
  ...CHAT_PANEL_TABS.map(
    (tab, index): KeyBinding => ({
      action: `panel-${tab}`,
      label: `This chat's ${CHAT_PANEL_LABELS[tab].toLowerCase()}`,
      chord: `Cmd+Alt+${index + 1}`,
      tier: "bound",
      match: { key: String(index + 1), code: `Digit${index + 1}`, meta: true, alt: true },
    }),
  ),
  { action: "newTask", label: "Start a new chat", chord: "Cmd+Shift+O", tier: "sheet" },
  { action: "settings", label: "Open settings", chord: "Cmd+.", tier: "sheet" },
  { action: "models", label: "Open the model picker", chord: "Cmd+Shift+M", tier: "sheet" },
];

/** Whether `event` is `binding`'s chord — every modifier it names, and none it does not. */
export function matches(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    readonly code?: string;
    readonly getModifierState?: (key: string) => boolean;
  },
  binding: KeyBinding,
): boolean {
  const match = binding.match;
  if (match === undefined) return false;
  // AltGr arrives as Ctrl+Alt on Windows and Linux, and types "@", "#" or "{"
  // on many layouts: it is a character, never a Cmd+Alt chord.
  if (match.alt === true && event.getModifierState?.("AltGraph") === true) return false;
  const physical = match.code !== undefined && event.code !== undefined && event.code !== "";
  if (physical ? event.code !== match.code : event.key.toLowerCase() !== match.key.toLowerCase()) return false;
  // Ctrl stands in for Cmd where there is no Cmd key, so one map serves both.
  if ((match.meta === true) !== (event.metaKey || event.ctrlKey)) return false;
  if ((match.alt === true) !== event.altKey) return false;
  if ((match.shift === true) !== event.shiftKey) return false;
  return true;
}

/**
 * Whether a key press may be a single-key shortcut (a list's `j`/`k`, a card's
 * `1`–`4`): no Cmd, Ctrl or Alt held, and not typed into a text field — a
 * textarea, or an input that takes text (`type="text"`, or no type at all).
 */
export function isBareKeyOutsideText(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as Partial<Pick<Element, "closest">> | null;
  return target?.closest?.("textarea, input[type=text], input:not([type])") == null;
}

/**
 * Bind the map's `primary` and `bound` chords for as long as the page is up.
 * A handler that is not given is not bound, so a chord the page cannot act on
 * is left to the browser rather than swallowed.
 */
export function useKeyboard(handlers: Partial<Record<KeyAction, () => void>>): void {
  // Kept in a ref, so a caller may pass a fresh object every render without
  // the listener being torn down and re-added on each repaint. Written in an
  // effect: a render that is thrown away must not leave its handlers behind.
  const current = useRef(handlers);
  useEffect(() => {
    current.current = handlers;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape during composition is how a CJK reader cancels a candidate
      // window; the page does not take it, as it does not take a composing Enter.
      // Native dialogs own Escape and must not trigger actions in the inert page.
      if (event.isComposing || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      for (const binding of KEY_MAP) {
        if (binding.tier === "sheet" || !matches(event, binding)) continue;
        const handler = current.current[binding.action];
        if (handler === undefined) continue;
        event.preventDefault();
        handler();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
