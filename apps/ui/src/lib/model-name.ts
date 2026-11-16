/**
 * Reduce a model's full identifier/display-name to a concise label for the selector
 * (e.g. "OpenAI: GPT-4.1 Mini" -> "GPT-4.1 Mini", "openai/gpt-4.1-mini" -> "gpt-4.1-mini").
 */
export function reduceModelName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return trimmed;
  const colonIdx = trimmed.indexOf(": ");
  if (colonIdx !== -1 && colonIdx + 2 < trimmed.length) {
    return trimmed.slice(colonIdx + 2).trim();
  }
  const slashIdx = trimmed.lastIndexOf("/");
  if (slashIdx !== -1 && slashIdx + 1 < trimmed.length) {
    return trimmed.slice(slashIdx + 1).trim();
  }
  return trimmed;
}
