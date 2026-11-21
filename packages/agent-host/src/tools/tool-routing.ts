import { z } from "zod";
import {
  DISCOVERED_TOOLS_MAX,
  MAX_MODEL_TOOLS,
  ROUTED_TOOLS_MAX,
  TaviError,
  type ModelToolDescriptor,
  type RouterDecisionInput,
  type RouterPort,
  type ToolDefinition,
  type ToolRegistryPort,
  toolPatternMatches,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

export const TOOL_SEARCH_ID = "tools.search";
export const ToolSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(8).default(8),
});
export const toolSearchDefinition: ToolDefinition = {
  id: TOOL_SEARCH_ID,
  version: "1",
  description:
    "Find currently authorized tools by what they do, a family's name (`pdf`, `reminders.*`) for all of it, or exactly with `select:<id>[,<id>]`. Matching tools become available on the next generation. This does not execute them.",
  effect: "read-only",
  requiredPermissions: ["tools.invoke"],
};
export const toolSearchDescriptor: ModelToolDescriptor = {
  id: TOOL_SEARCH_ID,
  name: "tools_search",
  description: toolSearchDefinition.description,
  inputJsonSchema: z.toJSONSchema(ToolSearchInput, { io: "input" }),
};
const protectedIds = new Set([TOOL_SEARCH_ID, "operator.ask_user", "agents.wait", "agents.read_payload"]);

/**
 * `tools.search` as one turn offers it: its
 * description gains a line for each server whose tools wait behind it and are
 * offered to this person here — the operator's line, or Tavi's own, never a
 * server's text. Its revision follows the description, so a changed line is
 * a changed tool.
 */
export function toolSearchDefinitionFor(lines: readonly string[]): ToolDefinition {
  if (lines.length === 0) return toolSearchDefinition;
  return {
    ...toolSearchDefinition,
    description: `${toolSearchDefinition.description}\nTools that wait behind this search:\n${lines.map((line) => `- ${line}`).join("\n")}`,
  };
}

/** The model's descriptor for one turn's `tools.search` definition. */
export function toolSearchDescriptorFor(definition: ToolDefinition): ModelToolDescriptor {
  return definition.description === toolSearchDescriptor.description
    ? toolSearchDescriptor
    : { ...toolSearchDescriptor, description: definition.description };
}

/** A tool's revision: its definition (a per-turn `tools.search` description included), schema and model name. */
export function toolRevision(registry: ToolRegistryPort, tool: ToolDefinition): string {
  return sha256Hex(
    JSON.stringify({
      tool,
      schema: tool.id === TOOL_SEARCH_ID ? toolSearchDescriptor.inputJsonSchema : registry.inputJsonSchemaOf(tool.id),
      name: tool.id === TOOL_SEARCH_ID ? toolSearchDescriptor.name : registry.modelNameOf(tool.id),
    }),
  );
}
/** Words a query is made of that say nothing about which tool it wants. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "do",
  "for",
  "from",
  "get",
  "give",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "show",
  "some",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "tool",
  "tools",
  "use",
  "want",
  "what",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

/** A plural as its singular, roughly: `memories` → `memory`, `searches` → `search`, `reminders` → `reminder`; `status`, `access` kept. */
function singular(word: string): string {
  if (word.length <= 3 || !word.endsWith("s") || word.endsWith("ss") || word.endsWith("us")) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

/**
 * The words of a query or a tool, lower-cased and split on `.`, `_` and `-`
 * as well as spaces (`reminders.create` is `reminders` and `create`), stop
 * words left out. A plural is read as its singular, so `reminder` meets `reminders`.
 */
export function toolSearchTerms(text: string): readonly string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOP_WORDS.has(word)).map(singular);
}

/** A query term found in a tool's id counts this many times one found only in its description. */
const ID_TERM_BOOST = 3;

/**
 * Each tool's score for `query`: the unique query terms it holds, each
 * weighted by how rare it is among the tools (a BM25-lite inverse document
 * frequency) and boosted when it is in the tool's id. Ties keep the tools'
 * order.
 */
function scored(query: string, tools: readonly ToolDefinition[]) {
  const terms = [...new Set(toolSearchTerms(query))];
  const documents = tools.map((tool) => ({
    id: new Set(toolSearchTerms(tool.id)),
    text: new Set(toolSearchTerms(`${tool.id} ${tool.description}`)),
  }));
  const weight = new Map(
    terms.map((term) => {
      const holding = documents.filter((document) => document.text.has(term)).length;
      return [term, Math.log(1 + (documents.length + 1) / (holding + 0.5))] as const;
    }),
  );
  return tools
    .map((tool, index) => {
      const document = documents[index]!;
      let score = 0;
      for (const term of terms) {
        if (document.id.has(term)) score += ID_TERM_BOOST * (weight.get(term) ?? 0);
        else if (document.text.has(term)) score += weight.get(term) ?? 0;
      }
      return { tool, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
/** The tools `query` finds, best first, at most `limit` (and 8); one the turn already offers (`offered`) is left out. */
export function discoverTools(
  query: string,
  tools: readonly ToolDefinition[],
  limit: number,
  offered: ReadonlySet<string> = new Set(),
): readonly ToolDefinition[] {
  const bound = Math.min(limit, 8);
  const findable = tools.filter((tool) => tool.id !== TOOL_SEARCH_ID);
  const trimmed = query.trim();
  // `select:<id>[,<id>]` names tools exactly, offered or not.
  if (trimmed.toLowerCase().startsWith("select:")) {
    const wanted = trimmed
      .slice("select:".length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    return wanted.flatMap((id) => findable.filter((tool) => tool.id === id)).slice(0, bound);
  }
  // A query that is a family's name (`pdf`, `reminders.*`) answers the whole family, in registry order.
  const family = trimmed.toLowerCase().replace(/\.\*$/, "");
  if (/^[a-z][a-z0-9_-]*$/.test(family)) {
    const members = findable.filter((tool) => tool.id.toLowerCase().startsWith(`${family}.`) && !offered.has(tool.id));
    if (members.length > 0) return members.slice(0, bound);
  }
  return scored(query, findable)
    .filter((entry) => entry.score > 0 && !offered.has(entry.tool.id))
    .slice(0, bound)
    .map((entry) => entry.tool);
}
/** A URL or host-shaped token (`smart.example.com`): the prompt names a site. */
const SITE_TOKEN = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i;
/** A site the prompt names is read with the browser; its words never mention one, so word overlap would not offer it. */
const SITE_TOOLS = ["browser.create_session", "browser.navigate", "browser.read"];

/**
 * A wish to be reminded, or a time (`tomorrow`, `every evening`, `at 9`, `at 21:00`, `by 7pm`): the
 * prompt asks to be told something later. A number after "at" or "by" is a time only when no other
 * word follows it ("at 3 files", "by 10 percent" are not), bar a time word ("at 9 tomorrow").
 */
const REMINDER_WORDS =
  /\b(?:remind(?:er|ers)?|alarm|tomorrow|tonight|appointment|forget|every\s+(?:day|morning|evening|night|week|mon|tue|wed|thu|fri|sat|sun)\w*)\b|\b(?:at|by)\s+\d{1,2}(?::[0-5]\d)?\s*(?:am|pm|o'?clock)?(?!\s*(?:[%\d]|(?!(?:am|pm|on|today|tomorrow|tonight|every|each|this|next|and|to)\b)[a-z]))/i;
/** Asked to be reminded, the reminder tools are offered even when the prompt's words would leave them out. */
const REMINDER_TOOLS = ["reminders.create", "reminders.list"];
/** The reminder and schedule tools a timed turn brings in when they wait behind `tools.search`. */
const REMINDER_DEFERRED_TOOLS: readonly string[] = [
  "reminders.update",
  "reminders.cancel",
  "reminders.snooze",
  "schedules.create",
  "schedules.list",
  "schedules.update",
  "schedules.pause",
];

/** Whether any of `texts` asks to be reminded, or names a time (`REMINDER_WORDS`). */
export function mentionsReminder(texts: readonly string[]): boolean {
  return texts.some((text) => REMINDER_WORDS.test(text));
}

/**
 * A PDF the conversation holds: its words two turns later ("fill out the packet") need not name one.
 * In the order they are kept when the router's picks leave little room: reading and filling first.
 */
/** The tools that open a web address: with none of them in a turn's catalog, no link can be checked. */
export const LINK_OPENING_TOOLS: readonly string[] = ["http.request", "web_fetch", "browser.navigate", "browser.create_session"];
export const PDF_TOOLS: readonly string[] = ["pdf.read", "pdf.fields", "pdf.fill", "pdf.overlay", "pdf.view", "pdf.render"];
/** A message that carries a PDF: an attachment line (`media-intake.ts`) or a `.pdf` path. */
const PDF_MENTION = /\(application\/pdf, |\.pdf\b/i;

/** Whether any of `texts` names a PDF. */
export function mentionsPdf(texts: readonly string[]): boolean {
  return texts.some((text) => PDF_MENTION.test(text));
}

/**
 * A video the conversation holds: its later words ("what am I doing wrong?") need not
 * name one. In the order they are kept when room is short: frames and the whole clip first.
 */
export const VIDEO_TOOLS: readonly string[] = ["video.frames", "video.view", "video.pose", "video.info", "video.transcribe"];
/** A message that carries a video or a GIF: an attachment line (`media-intake.ts`) or a video's path. */
const VIDEO_MENTION = /\((?:video\/[a-z0-9.+-]+|image\/gif), |\.(?:mp4|mov|m4v|3gp|webm|mkv|gif)\b/i;

/** Whether any of `texts` names a video. */
export function mentionsVideo(texts: readonly string[]): boolean {
  return texts.some((text) => VIDEO_MENTION.test(text));
}

/** A voice message or other audio the conversation holds: its speech is read with these. */
const AUDIO_TOOLS: readonly string[] = ["audio.transcribe"];
/** A message that carries audio: an attachment line (`media-intake.ts`). */
const AUDIO_MENTION = /\(audio\/[a-z0-9.+-]+, /i;

/** Whether any of `texts` names an audio attachment. */
export function mentionsAudio(texts: readonly string[]): boolean {
  return texts.some((text) => AUDIO_MENTION.test(text));
}

/**
 * Built-in families an attended chat finds through `tools.search` rather than
 * in its first tool list (`models.promptLayout` `v2`), each with the line
 * `tools.search` says of it while one of its tools is offered. Unattended
 * tasks and workers keep them listed while their list fits one request:
 * most have no allowlist that could name one, so deferring them there would
 * quietly take the tools away. Past that limit every surface defers them
 * (`createOfferScope`), so the MCP budget leaves them out (`McpBridge.limit`).
 */
const ATTENDED_DEFERRED_FAMILIES: readonly { readonly patterns: readonly string[]; readonly line: string }[] = [
  { patterns: ["routines.*"], line: "routines.*: create, change, run, pause and inspect routines" },
  {
    patterns: ["heartbeat.status", "heartbeat.propose"],
    line: "heartbeat.status, heartbeat.propose: read or propose the heartbeat's settings",
  },
  { patterns: ["pdf.*"], line: "pdf.*: read, fill, overlay and render PDF files" },
  { patterns: ["video.*"], line: "video.*: inspect, view, transcribe and track poses in videos" },
  { patterns: ["audio.*"], line: "audio.*: transcribe voice messages and other audio attachments" },
  { patterns: ["projects.*"], line: "projects.*: read a project's details" },
  { patterns: ["reports.*"], line: "reports.*: generate reports and read their history" },
  // Creating and listing reminders stay listed; a reminder turn brings these in (`documentTools`).
  {
    patterns: ["reminders.update", "reminders.cancel", "reminders.snooze"],
    line: "reminders.update, reminders.cancel, reminders.snooze: change, cancel or snooze a reminder",
  },
  // Adding, listing and ticking off to-dos stay listed; changing and removing one is found when asked.
  { patterns: ["todos.update", "todos.remove"], line: "todos.update, todos.remove: change or remove a to-do" },
  // A timed turn brings in all but resume and cancel (`documentTools`).
  { patterns: ["schedules.*"], line: "schedules.*: create, change, run now, pause, resume and cancel prompts run on a schedule" },
  { patterns: ["findings.*"], line: "findings.*: read and manage what collectors found" },
  { patterns: ["plugins.*"], line: "plugins.*: write, check and manage plugins" },
  {
    patterns: ["agents.send", "agents.request", "agents.reply", "agents.cancel"],
    line: "agents.send, agents.request, agents.reply, agents.cancel: message or stop a delegated task",
  },
];

const deferredFamilyOf = (toolId: string) =>
  ATTENDED_DEFERRED_FAMILIES.find((family) => family.patterns.some((pattern) => toolPatternMatches(pattern, toolId)));

/** Whether `toolId` is in one of `ATTENDED_DEFERRED_FAMILIES`. */
export function inAttendedDeferredFamily(toolId: string): boolean {
  return deferredFamilyOf(toolId) !== undefined;
}

/** `tools` with the built-in families an attended chat defers (`ATTENDED_DEFERRED_FAMILIES`) marked `deferred`. */
export function deferAttendedFamilies(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => (tool.deferred !== true && inAttendedDeferredFamily(tool.id) ? { ...tool, deferred: true } : tool));
}

/** The `tools.search` lines for the deferred built-in families `tools` offers, in `ATTENDED_DEFERRED_FAMILIES` order. */
export function deferredFamilyLines(tools: readonly ToolDefinition[]): string[] {
  const offered = new Set(tools.flatMap((tool) => deferredFamilyOf(tool.id) ?? []));
  return ATTENDED_DEFERRED_FAMILIES.filter((family) => offered.has(family)).map((family) => family.line);
}

/**
 * The deferred tools an allowlist names, by exact id or by pattern (`mcp.files.*`): offered directly, as the
 * task has no `tools.search` to find them. `*` alone names nothing — it is no choice of a tool.
 */
export function namedTools(tools: readonly ToolDefinition[], allowlist: readonly string[] | undefined): ReadonlySet<string> {
  const patterns = (allowlist ?? []).filter((pattern) => pattern !== "*");
  return new Set(
    tools
      .filter((tool) => tool.deferred === true && patterns.some((pattern) => toolPatternMatches(pattern, tool.id)))
      .map((tool) => tool.id),
  );
}

/**
 * The PDF, video and audio tools a conversation calls for, in the order they are kept: PDF and video both held, the
 * first three of each go first; a voice message's one tool goes ahead of them all, as it is the message itself.
 */
export function documentTools(pdf: boolean, video: boolean, reminder = false, audio = false): readonly string[] {
  const documents =
    pdf && video
      ? [...PDF_TOOLS.slice(0, 3), ...VIDEO_TOOLS.slice(0, 3), ...PDF_TOOLS.slice(3), ...VIDEO_TOOLS.slice(3)]
      : pdf
        ? PDF_TOOLS
        : video
          ? VIDEO_TOOLS
          : [];
  const withAudio = audio ? [...AUDIO_TOOLS, ...documents] : documents;
  return reminder ? [...REMINDER_DEFERRED_TOOLS, ...withAudio] : withAudio;
}

/** Stable registry ordering; requested discoveries have priority over older optional entries. */
export function shortlistTools(
  tools: readonly ToolDefinition[],
  query: string,
  selected: readonly string[],
  discovered: readonly string[],
  protectedTools: ReadonlySet<string> = protectedIds,
  conversation: {
    readonly pdfInConversation?: boolean;
    readonly videoInConversation?: boolean;
    readonly audioInConversation?: boolean;
  } = {},
): readonly ToolDefinition[] {
  const protectedSet = tools.filter((tool) => protectedTools.has(tool.id));
  if (protectedSet.length > MAX_MODEL_TOOLS)
    throw new TaviError("INVALID_INPUT", `Protected workflow tools exceed the ${MAX_MODEL_TOOLS}-descriptor model contract`);
  const available = new Set(tools.map((tool) => tool.id));
  const expansions = [...new Set(discovered)].filter((id) => available.has(id) && !protectedTools.has(id)).slice(0, 8);
  const ranked = selected.length > 0 ? selected : scored(query, tools).map(({ tool }) => tool.id);
  // The reminder, PDF and video tools go ahead of a lexical ranking, but after the router's own picks: they
  // fill the room those leave and never displace one.
  const reminders = [
    ...(REMINDER_WORDS.test(query) ? REMINDER_TOOLS : []),
    ...documentTools(
      conversation.pdfInConversation === true,
      conversation.videoInConversation === true,
      false,
      conversation.audioInConversation === true,
    ),
  ];
  const preferred = [
    ...(SITE_TOKEN.test(query) ? SITE_TOOLS : []),
    ...(selected.length > 0 ? [...ranked, ...reminders] : [...reminders, ...ranked]),
  ];
  // A deferred tool comes in only once `tools.search` found it (an expansion), never by rank — bar the PDF and
  // video tools a document the conversation holds calls for, which may pass the expansions' eight.
  const documents = new Set(
    documentTools(
      conversation.pdfInConversation === true,
      conversation.videoInConversation === true,
      false,
      conversation.audioInConversation === true,
    ),
  );
  const deferred = new Set(tools.filter((tool) => tool.deferred === true && !documents.has(tool.id)).map((tool) => tool.id));
  const optional = [...new Set(preferred)]
    .filter((id) => available.has(id) && !protectedTools.has(id) && !expansions.includes(id) && !deferred.has(id))
    .slice(0, 12);
  const ids = new Set([...protectedSet.map((tool) => tool.id), ...expansions, ...optional].slice(0, MAX_MODEL_TOOLS));
  return tools.filter((tool) => ids.has(tool.id));
}

/**
 * `models.promptLayout` `v2`'s routed tool list: the tools earlier turns of
 * the epoch were offered (`routed`, in the order first offered, those still
 * authorized), then what this turn's shortlist adds, in registry order — so
 * routing only ever appends to the array that leads the cached prefix. At
 * most `MAX_MODEL_TOOLS`: past it, the oldest routed tools give way, never a
 * protected one or one this turn's shortlist chose.
 */
export function routedToolList(
  tools: readonly ToolDefinition[],
  routed: readonly string[],
  shortlist: readonly ToolDefinition[],
  protectedTools: ReadonlySet<string> = protectedIds,
): readonly ToolDefinition[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const chosen = new Set(shortlist.map((tool) => tool.id));
  // Every earlier tool keeps its place, chosen again or not: a tool this turn's shortlist picks again must not
  // move behind the others, or the array that leads the cached prefix changes.
  const earlier = routed.filter((id) => byId.has(id));
  const earlierSet = new Set(earlier);
  const added = shortlist.map((tool) => tool.id).filter((id) => !earlierSet.has(id));
  // Past the bound, the oldest earlier tools that are neither protected nor chosen this turn give way.
  const removable = earlier.filter((id) => !protectedTools.has(id) && !chosen.has(id));
  const dropped = new Set(removable.slice(0, Math.max(0, earlier.length + added.length - MAX_MODEL_TOOLS)));
  return [...earlier.filter((id) => !dropped.has(id)), ...added].flatMap((id) => {
    const tool = byId.get(id);
    return tool === undefined ? [] : [tool];
  });
}

/** The ids `routedToolList` offered, to keep for the epoch's next turn (`routedToolIds`). */
export function routedToolIdsOf(list: readonly ToolDefinition[]): string[] {
  return list.map((tool) => tool.id).slice(0, ROUTED_TOOLS_MAX);
}

/**
 * `models.promptLayout` `v2`'s discovered tools after a search found `found`:
 * the earlier ones where they were, the new ones after them in the order
 * found, the oldest giving way past `DISCOVERED_TOOLS_MAX`.
 */
export function appendDiscovered(discovered: readonly string[], found: readonly string[]): string[] {
  const known = new Set(discovered);
  return [...discovered, ...[...new Set(found)].filter((id) => !known.has(id))].slice(-DISCOVERED_TOOLS_MAX);
}

/**
 * An unrouted turn's tool list: deferred tools
 * only once `tools.search` found them, with `tools.search` offered while any
 * is left out (when `searchable`); then, as the last guard, MCP tools dropped
 * from the end of the list until it fits the model contract. MCP tools never
 * make a turn fail.
 */
export function fitToolList(
  tools: readonly ToolDefinition[],
  discovered: readonly string[],
  searchable: boolean,
  options: {
    /** This turn's `tools.search` (`toolSearchDefinitionFor`). */
    readonly search?: ToolDefinition;
    /** Tools a task's allowlist names exactly (a heartbeat's choices): offered directly, deferred or not. */
    readonly named?: ReadonlySet<string>;
    /**
     * `models.promptLayout` `v2`: discovered tools go after the rest, in the order found (`discovered` is kept
     * in that order), so a discovery appends to the array rather than landing at its registry position.
     */
    readonly appendDiscovered?: boolean;
  } = {},
): readonly ToolDefinition[] {
  const found = new Set([...discovered, ...(options.named ?? [])]);
  const listed =
    options.appendDiscovered === true
      ? [
          ...tools.filter((tool) => tool.deferred !== true || options.named?.has(tool.id) === true),
          ...discovered.flatMap((id) => {
            const tool = tools.find((candidate) => candidate.id === id);
            return tool !== undefined && tool.deferred === true && options.named?.has(id) !== true ? [tool] : [];
          }),
        ]
      : tools.filter((tool) => tool.deferred !== true || found.has(tool.id));
  const withheld = listed.length < tools.length;
  let fitted =
    withheld && searchable && !listed.some((tool) => tool.id === TOOL_SEARCH_ID)
      ? [...listed, options.search ?? toolSearchDefinition]
      : [...listed];
  // Appended discoveries are the tools a search just reported found: past the bound, the other MCP tools go
  // first, then the oldest discoveries.
  const appended = options.appendDiscovered === true ? new Set(discovered) : new Set<string>();
  while (fitted.length > MAX_MODEL_TOOLS) {
    const listedMcp = fitted.findLastIndex((tool) => tool.id.startsWith("mcp.") && !appended.has(tool.id));
    const oldestFound = fitted.findIndex((tool) => tool.id.startsWith("mcp.") && appended.has(tool.id));
    const drop = listedMcp !== -1 ? listedMcp : oldestFound;
    if (drop === -1) break;
    fitted = [...fitted.slice(0, drop), ...fitted.slice(drop + 1)];
  }
  return fitted;
}

export function toolAdviceCandidates(registry: ToolRegistryPort, tools: readonly ToolDefinition[]) {
  return tools
    .filter((tool) => !protectedIds.has(tool.id) && tool.deferred !== true)
    .map((tool) => ({ id: tool.id, revision: toolRevision(registry, tool), description: tool.description }));
}

export async function selectToolAdvice(
  service: RouterPort,
  registry: ToolRegistryPort,
  input: Omit<RouterDecisionInput, "candidates" | "feature">,
  tools: readonly ToolDefinition[],
): Promise<readonly string[]> {
  const receipt = await service.decide({ ...input, feature: "tools", candidates: toolAdviceCandidates(registry, tools) });
  return receipt.mode === "active" && (await input.isCurrent()) ? receipt.selectedIds : [];
}
