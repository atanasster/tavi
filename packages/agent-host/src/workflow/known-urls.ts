import {
  isPlumbingOrigin,
  KNOWN_URL_LIMITS,
  navigationKeyOf,
  urlKeysIn,
  type SourceKind,
  isPersonMessage,
  type WorkflowMessage,
} from "@tavi/contracts";

/** The string leaves of a value, depth- and count-bounded: where a tool result's or a call input's URLs are. */
export function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 4_096) return;
  if (typeof value === "string") out.push(value);
  else if (depth < 12 && Array.isArray(value)) for (const entry of value) stringLeaves(entry, out, depth + 1);
  else if (depth < 12 && typeof value === "object" && value !== null)
    for (const entry of Object.values(value)) stringLeaves(entry, out, depth + 1);
}

/** The URL keys (`urlKeysIn`) of `texts`, each once, in order. */
export function urlKeysOf(texts: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const text of texts) {
    for (const key of urlKeysIn(text)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** The normal form a URL key stands for: the key without its fragment. */
export const unfragmented = (key: string): string => {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
};

/**
 * The person's own words in `messages`, never a
 * model's, never quoted data. A worker's prompts are its spawning model's
 * words (`agent` origin), and a heartbeat check's prompt carries its signals
 * and the pages it watches (`heartbeat` origin): none of their messages
 * count. A heartbeat's watched pages are known through its tools'
 * `vouchedUrls`.
 */
export function personTexts(messages: readonly WorkflowMessage[], origin: string | null | undefined): readonly string[] {
  return origin === "agent" || isPlumbingOrigin(origin)
    ? []
    : messages.filter((message) => isPersonMessage(message)).map((message) => message.text);
}

/**
 * The sources whose words a tool result brings in from outside Tavi and its
 * models: only such a result makes the URLs it holds known. A
 * worker's or a peer's answer (`agent`), a past chat, a routine's output, a
 * sandbox's output or a file in the chat's managed folder (`sandbox`), and
 * every trusted store (findings, the plan, notes) hold what a model may have
 * written, so a URL it composed through one of them stays novel.
 */
export const OUTSIDE_RESULT_SOURCES: ReadonlySet<SourceKind> = new Set([
  "web",
  "search",
  "email",
  "mcp",
  "plugin",
  "heartbeat",
  "attachment",
  "download",
]);

/**
 * The keys of the URLs tool results hold, for the `knownUrls` channel, as the
 * results enter the conversation: a page's listed links and a `web_fetch`'s
 * redirect hops and final URL included — only of a result from outside
 * (`outside`, `OUTSIDE_RESULT_SOURCES`). A URL the model wrote before
 * (`modelWritten`) is left out: a result that echoes it (a page that reflects
 * a query, a search hit) must not make the model's own URL known.
 */
export function resultUrlKeys(
  results: readonly WorkflowMessage[],
  known: readonly string[],
  modelWritten: ReadonlySet<string>,
  outside: (message: WorkflowMessage) => boolean,
): readonly string[] {
  const texts: string[] = [];
  for (const message of results) {
    if (message.role !== "tool" || !outside(message)) continue;
    texts.push(message.text);
    stringLeaves(message.output, texts);
  }
  const have = new Set(known);
  const keys = urlKeysOf(texts).filter((key) => !have.has(key) && !modelWritten.has(key) && !modelWritten.has(unfragmented(key)));
  return keys.length > KNOWN_URL_LIMITS.maxUrls ? keys.slice(keys.length - KNOWN_URL_LIMITS.maxUrls) : keys;
}

/** A URL's origin as `typedPages` keeps it (`https://host/`); undefined for one that does not parse. */
export function originKeyOf(url: string): string | undefined {
  try {
    return navigationKeyOf(new URL(url).origin);
  } catch {
    return undefined;
  }
}

/**
 * The set the gate's known-URL rule reads for one call: the
 * checkpointed `knownUrls` channel (tool results as they arrived, the
 * person's messages, approvals), the person's messages still in the
 * conversation, and the system's own text — the Tavi-authored prompt and the
 * manifest rendered for this request (skills, endorsed memory), never the
 * context block's epoch summaries. Never a tool result read again here: only
 * the channel knows whether the model wrote its URL first.
 */
export function knownUrlSetOf(
  channel: readonly string[],
  conversation: readonly WorkflowMessage[],
  systemText: string,
  origin: string | null | undefined,
): ReadonlySet<string> {
  return new Set([...channel, ...urlKeysOf([...personTexts(conversation, origin), systemText])]);
}

/** A typed-into page as `typedPages` keeps it: the session and the page's origin, `*` when the page is not known. */
export const typedPageEntry = (sessionId: string, origin: string | undefined): string => `${sessionId} ${origin ?? "*"}`;

/**
 * Whether a browser result is a read of a page the model typed into
 * (`typedPages`): of its session, on the origin it typed on, or on any
 * page of the session when the typing's page or this result's is not known.
 * Such a page may show what was typed, so its URLs are never made known.
 */
export function readsTypedPage(
  message: WorkflowMessage,
  typed: ReadonlySet<string>,
  inputOf: (callId: string | undefined) => unknown,
): boolean {
  if (typed.size === 0 || message.role !== "tool" || message.toolName?.startsWith("browser.") !== true) return false;
  const field = (value: unknown, key: string): string | undefined => {
    const found = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
    return typeof found === "string" ? found : undefined;
  };
  const sessionId = field(message.output, "sessionId") ?? field(inputOf(message.toolCallId), "sessionId");
  if (sessionId === undefined) return true;
  const page = field(message.output, "url");
  const origin = page === undefined ? undefined : originKeyOf(page);
  return (
    typed.has(typedPageEntry(sessionId, "*")) ||
    (origin === undefined ? [...typed].some((entry) => entry.startsWith(`${sessionId} `)) : typed.has(typedPageEntry(sessionId, origin)))
  );
}
