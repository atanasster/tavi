import type { Outcome } from "./ipc.js";

/** What a chunked read needs of each chunk: where it starts, which body it is of, and where the next starts (`null`: it is the last). */
export interface ReadChunk {
  readonly offset: number;
  readonly hash: string;
  readonly nextOffset: number | null;
}

/**
 * A body read chunk by chunk (`artifacts read`, `routines artifact`): each
 * chunk asked for at the offset the one before named, and handed to `take`,
 * until the last, which is the answer. A chunk at another offset than asked,
 * or of another body than the first (its `hash`), ends the read in `changed`'s
 * words; one `take` refuses, in the words it returns; more than `maxChunks`,
 * in `tooLarge`'s.
 */
export async function readChunks<C extends ReadChunk>(
  fetchChunk: (offset: number) => Promise<Outcome<C>>,
  take: (chunk: C) => string | undefined,
  words: { readonly changed: string; readonly tooLarge?: string; readonly maxChunks?: number },
): Promise<Outcome<C>> {
  let offset = 0;
  let hash: string | undefined;
  for (let count = 0; words.maxChunks === undefined || count < words.maxChunks; count += 1) {
    const answer = await fetchChunk(offset);
    if (!answer.ok) return answer;
    const chunk = answer.value;
    if ((hash !== undefined && chunk.hash !== hash) || chunk.offset !== offset) return { ok: false, message: words.changed };
    hash = chunk.hash;
    const problem = take(chunk);
    if (problem !== undefined) return { ok: false, message: problem };
    if (chunk.nextOffset === null) return answer;
    offset = chunk.nextOffset;
  }
  return { ok: false, message: words.tooLarge ?? words.changed };
}
