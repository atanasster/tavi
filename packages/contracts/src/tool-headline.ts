/**
 * The one line a reader scans a tool call by: the path, URL, query or command
 * it touched. The transcript's tool card and the
 * approvals inbox both show it, so the table lives here rather than in either.
 *
 * Keyed by tool family, the part of a tool id before the first dot; the field
 * names are the ones the families' input schemas carry (their registration
 * sites are in `apps/cli/src/*-tools.ts`, `web-search.ts` and
 * `agent-communication.ts`). A family missing here has no headline, which is
 * the contract rather than an oversight: the caller shows the tool id alone.
 */

import { coreEnglish, type CoreT } from "./locales/core.js";
import type { CoreKey } from "./locales/core-en.js";

/** What the collectors and the report tools are scoped by. */
const PROJECT_FIELDS = ["projectId", "metricKey"] as const;

export const TOOL_HEADLINE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  agents: ["agentDefinitionId", "recipientAgentId", "operationKey"],
  artifacts: ["messageId", "artifactId"],
  // A page by its address; an element's ref (`el-2`) or a session id says nothing to a person.
  browser: ["url"],
  collect: PROJECT_FIELDS,
  // A file call by its path: a waiting write is "Write notes.txt" in every list (`toolCallTitle`), never its tool id alone.
  fs: ["path"],
  gcp: PROJECT_FIELDS,
  gsc: PROJECT_FIELDS,
  http: ["url"],
  memory: ["query", "recordId"],
  messaging: ["chatId", "connectionId"],
  news: PROJECT_FIELDS,
  operator: ["question"],
  // A PDF source is an object (a path or an artifact), so only a fill's output heads its card.
  pdf: ["output"],
  projects: PROJECT_FIELDS,
  reports: PROJECT_FIELDS,
  sandbox: ["command"],
  stripe: PROJECT_FIELDS,
  // A video source is an object (a path or an artifact): a pose call's movement, or a frames call's mode, heads its card.
  video: ["movement", "mode"],
  web: ["query", "url"],
};

/** Every field any family reads, so a store can extract just these from a stored input. */
export const TOOL_HEADLINE_INPUT_FIELDS: readonly string[] = [...new Set(Object.values(TOOL_HEADLINE_FIELDS).flat())].sort();

/** The longest headline, in characters; a longer one is cut with an ellipsis. */
export const TOOL_HEADLINE_MAX_CHARS = 72;

/** The family a tool id belongs to: `web_search` and `web_fetch` are `web`. */
export function toolFamily(toolId: string): string {
  return toolId === "web_search" || toolId === "web_fetch" ? "web" : (toolId.split(".", 1)[0] ?? "");
}

/**
 * The headline of one call, or `undefined` when its family has none or its
 * input carries none of the family's fields. Only the first line of the first
 * non-empty string (or finite number) field is used, clamped to
 * `TOOL_HEADLINE_MAX_CHARS`. Never throws: tool input is `unknown` by contract.
 */
export function toolCallHeadline(toolId: string, input: unknown): string | undefined {
  const family = toolFamily(toolId);
  // `hasOwn`, not a plain lookup: a tool id may be `constructor.x`.
  if (!Object.hasOwn(TOOL_HEADLINE_FIELDS, family) || typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const name of TOOL_HEADLINE_FIELDS[family] ?? []) {
    const value = record[name];
    const text =
      typeof value === "string" && value !== "" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
    if (text === undefined) continue;
    const line = text.split("\n", 1)[0] ?? "";
    return line.length > TOOL_HEADLINE_MAX_CHARS ? `${line.slice(0, TOOL_HEADLINE_MAX_CHARS - 1)}…` : line;
  }
  return undefined;
}

/** What a call does, in a word or two, for the tools a person is asked about most; others go by their tool id. */
const TOOL_CALL_VERBS: Readonly<Record<string, CoreKey>> = {
  "browser.navigate": "tool.title.browserNavigate",
  "fs.delete": "tool.title.fsDelete",
  "fs.edit": "tool.title.fsEdit",
  "fs.list": "tool.title.fsList",
  "fs.read": "tool.title.fsRead",
  "fs.write": "tool.title.fsWrite",
  "http.request": "tool.title.httpRequest",
  "pdf.fill": "tool.title.pdfFill",
  "sandbox.run": "tool.title.sandboxRun",
  web_fetch: "tool.title.webFetch",
  web_search: "tool.title.webSearch",
};

/**
 * A call as a list titles it: "Write notes.txt" when its tool has a verb and
 * the call a headline, else its tool id with the headline, else the tool id —
 * never the tool id twice.
 */
export function toolCallTitle(toolId: string, summary: string | undefined, t: CoreT = coreEnglish): string {
  if (summary === undefined || summary === "") return toolId;
  const verb = Object.hasOwn(TOOL_CALL_VERBS, toolId) ? TOOL_CALL_VERBS[toolId] : undefined;
  return verb === undefined ? `${toolId} ${summary}` : t(verb, { subject: summary });
}

/** Whether a card's detail is a file change's unified diff (`--- path` then `+++ path`), not free text that starts like one. */
export function isUnifiedDiff(detail: string | undefined): detail is string {
  return detail !== undefined && /^--- [^\n]*\n\+\+\+ /.test(detail);
}
