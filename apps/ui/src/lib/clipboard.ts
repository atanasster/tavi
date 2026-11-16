/**
 * Copying text to the clipboard.
 *
 * One helper for the whole canvas: the browser API is absent in some contexts
 * (a non-secure origin, an old engine) and rejects in others (a denied
 * permission), so callers must handle "could not copy" rather than assume it.
 * Returns whether the browser allowed the write; never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText: (value: string) => Promise<void> } } }).navigator?.clipboard;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A draft copied for safe keeping (its save was refused), and what the page says about it. */
export async function copyDraft(text: string): Promise<string> {
  return (await copyText(text)) ? "The draft is on your clipboard." : "Could not copy the draft; select the text and copy it manually.";
}
