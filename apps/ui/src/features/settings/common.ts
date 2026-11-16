import { MAX_SYSTEM_PROMPT_CODE_UNITS } from "@tavi/contracts";

/**
 * The canvas's settings: the owner's model connections and
 * their catalogs, its web search providers, and its credential references —
 * read and written through `@tavi/client`, the same IPC families `tavi
 * models|search|credentials` use under a live owner. Nothing here is Meggy's:
 * the ported views (`ModelBrowser`, `WebSearchFormModal`) render these shapes.
 */

/**
 * The owner's value bounds, so a form says so before the owner is asked
 * (`SearchPayloadSchema`, `CredentialsPayloadSchema`, `SystemPromptPayloadSchema`).
 *
 * `systemPrompt` is in JavaScript string code units, matching the contract's
 * bound and the DOM `maxLength` — not UTF-8 bytes.
 */
export const SETTINGS_BOUNDS = {
  baseUrl: 500,
  providerId: 64,
  reference: 128,
  value: 16 * 1024,
  // Taken from the contract rather than restated: the editor's bound and the
  // schema's are the same number, and a copy would drift from it.
  systemPrompt: MAX_SYSTEM_PROMPT_CODE_UNITS,
} as const;

/** A write's note, when the running owner offers what it wrote only after a restart. */
export function restartNote(result: unknown, family: "models" | "search"): string | undefined {
  if ((result as { readonly restartRequired?: boolean } | undefined)?.restartRequired !== true) return undefined;
  return family === "models"
    ? "Saved. The running owner keeps its startup target: restart `tavi serve` for this to take effect."
    : "Saved. Restart `tavi serve` for the model to be offered web search.";
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;
