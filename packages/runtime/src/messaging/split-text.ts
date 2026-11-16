import { isFilePart, type OutboundMessage } from "@tavi/contracts";

/**
 * Text longer than a channel's `maxTextLength` cut into pieces that each fit:
 * at the last paragraph break that fits, else line break, else sentence end,
 * else space, else at the limit itself — so no core code needs to know any
 * provider's limit, and no piece is cut mid-word when a boundary exists.
 */
export function splitText(text: string, limit: number): readonly string[] {
  if (limit < 1 || text.length <= limit) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // A window that ends just before whitespace is a whole piece already.
    const cut = /\s/.test(rest.charAt(limit)) ? limit : lastBoundary(window);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}

/** Where to cut a window: just after its last good boundary in the latter half, else at its end. */
function lastBoundary(window: string): number {
  const floor = Math.floor(window.length / 2);
  for (const boundary of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
    const at = window.lastIndexOf(boundary);
    if (at >= floor) return at + boundary.length;
  }
  // No boundary: cut at the limit, but never between a surrogate pair's halves.
  const code = window.charCodeAt(window.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? window.length - 1 : window.length;
}

/**
 * One message as the messages it must go out as: itself when its text fits,
 * else one per piece of its single text part. Each piece is its own effect
 * (`<effectId>#1`, `#2`, …) so a retry finds each recorded outcome, while
 * the message's own effect holds their combined one; the subject travels with
 * every piece, a reply-to with the first, and buttons with the last, under
 * the whole text.
 */
export function splitMessage(message: OutboundMessage, limit: number): readonly OutboundMessage[] {
  const [part, ...others] = message.parts;
  if (part === undefined || others.length > 0 || isFilePart(part) || part.content.length <= limit) return [message];
  const pieces = splitText(part.content, limit);
  if (pieces.length <= 1) return [message];
  const { buttons, replyToId, ...rest } = message;
  return pieces.map((piece, index) => ({
    ...rest,
    effectId: `${message.effectId}#${index + 1}`,
    parts: [{ content: piece }],
    ...(index === 0 && replyToId !== undefined ? { replyToId } : {}),
    ...(index === pieces.length - 1 && buttons !== undefined ? { buttons } : {}),
  }));
}
