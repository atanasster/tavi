/**
 * Past-chat search, `sessions.search`:
 * the shape of its answer, declared here so the tool, the terminal chat and
 * the canvas read one shape.
 *
 * The answer is `{ found, matches }`, each match `{ taskId, title, at,
 * excerpt }`: which chat (its id and its title as the chat list shows it),
 * when the matching turn was admitted, and up to 300 characters around the
 * first match. A card is drawn from the call's event `output`, which
 * `boundEventPayload` replaces with a truncated preview once its JSON passes
 * `MAX_EVENT_PAYLOAD_BYTES` — ten excerpts in Japanese do — so `found` comes
 * first and each match names its chat before its excerpt: a preview still
 * says how many were found and cites every chat it holds whole.
 */
export const SESSIONS_SEARCH_TOOL_ID = "sessions.search";

/** One chat past-chat search found. */
export interface PastChatHit {
  readonly taskId: string;
  /**
   * The chat's title as the chat list shows it: the reader's rename, Home, the generated title, else the first line of its prompt.
   * A chat whose memory was turned back on has only a rename or Home; with neither, or none at all, "Untitled chat".
   */
  readonly title: string;
  /** When the excerpt's turn was admitted. */
  readonly at: string;
  readonly excerpt: string;
}

/** A chat a search cited: what a card links to. */
export interface PastChatCitation {
  readonly taskId: string;
  readonly title: string;
}

/** A task id a card may link to: what the store mints, never a path or a URL. */
const CITED_TASK_ID = /^[\w.:-]{1,128}$/;

/** The longest title a card shows. */
const CITED_TITLE_MAX_CHARS = 120;

function citation(taskId: unknown, title: unknown): PastChatCitation | undefined {
  if (typeof taskId !== "string" || !CITED_TASK_ID.test(taskId) || typeof title !== "string") return undefined;
  const line = title.replace(/\s+/g, " ").trim().slice(0, CITED_TITLE_MAX_CHARS);
  return { taskId, title: line === "" ? "Untitled chat" : line };
}

/** A JSON string literal's value, or undefined when it is not one. */
function stringLiteral(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many chats a `sessions.search` answer found and the chats it cites, in
 * its order, each once; `undefined` for an output that is not one. Read from
 * the answer itself, or from the truncated preview an oversized one became:
 * then `found` is still whole, and the chats are those whose id and title the
 * preview holds.
 */
export function pastChatSearchCitations(
  output: unknown,
): { readonly found: number; readonly chats: readonly PastChatCitation[] } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as {
    readonly found?: unknown;
    readonly matches?: unknown;
    readonly truncated?: unknown;
    readonly preview?: unknown;
  };
  const chats: PastChatCitation[] = [];
  const seen = new Set<string>();
  const add = (cited: PastChatCitation | undefined) => {
    if (cited === undefined || seen.has(cited.taskId)) return;
    seen.add(cited.taskId);
    chats.push(cited);
  };
  if (Array.isArray(record.matches)) {
    for (const match of record.matches as unknown[]) {
      if (typeof match !== "object" || match === null) continue;
      const hit = match as { readonly taskId?: unknown; readonly title?: unknown };
      add(citation(hit.taskId, hit.title));
    }
    const found =
      typeof record.found === "number" && Number.isSafeInteger(record.found) && record.found >= 0 ? record.found : record.matches.length;
    return { found, chats };
  }
  if (record.truncated !== true || typeof record.preview !== "string") return undefined;
  const found = /^\{"found":(\d{1,4})[,}]/.exec(record.preview);
  if (found === null) return undefined;
  for (const match of record.preview.matchAll(/\{"taskId":("(?:[^"\\]|\\.)*"),"title":("(?:[^"\\]|\\.)*")/g)) {
    add(citation(stringLiteral(match[1]!), stringLiteral(match[2]!)));
  }
  return { found: Number(found[1]), chats };
}

/** A search card's line: "Searched earlier chats · 3 found". */
export function pastChatSearchSummary(found: number): string {
  return `Searched earlier chats · ${found} found`;
}
