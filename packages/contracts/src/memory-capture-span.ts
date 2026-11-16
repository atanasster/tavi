import { MEMORY_PROVIDER_LIMITS, type MemoryCaptureMessage } from "./memory-provider.js";
import { clip } from "./util.js";

/*
 * The span a capture call reads: which messages, cut how, and rendered how.
 * The host's idle review and epoch flush select with it, and a memory
 * provider may too (`@tavi/plugin-kit/memory` names it for one).
 */

/** One message's share of a span, at most. */
export const CAPTURE_SPAN_MESSAGE_CHARS = 1_500;

const spanLine = (message: Pick<MemoryCaptureMessage, "role" | "text">): string => `[${message.role}] ${JSON.stringify(message.text)}`;

/**
 * The part of a span a capture call reads: each message trimmed and cut to
 * its share, the newest kept while the rendered budget lasts, shown in
 * order. Empty messages are left out. Selecting what this answers again
 * keeps all of it, so a provider may select a span the host already bounded.
 */
export function selectCaptureSpan<Message extends Pick<MemoryCaptureMessage, "role" | "text">>(
  messages: readonly Message[],
  maxChars: number = MEMORY_PROVIDER_LIMITS.spanChars,
): Message[] {
  const kept: Message[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const text = message.text.trim();
    if (text === "") continue;
    const cut = { ...message, text: clip(text, CAPTURE_SPAN_MESSAGE_CHARS) };
    const length = spanLine(cut).length;
    if (used + length + 1 > maxChars) break;
    kept.unshift(cut);
    used += length + 1;
  }
  return kept;
}

/** A selected span as a capture call reads it: one `[person]` or `[assistant]` line a message, its words quoted. */
export function renderCaptureSpan(span: readonly Pick<MemoryCaptureMessage, "role" | "text">[]): string {
  return span.map(spanLine).join("\n");
}
