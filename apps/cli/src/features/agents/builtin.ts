import { AGENT_PAYLOAD_TOOL_ID, GENERAL_WORKER_AGENT_ID } from "./tools.js";
import type { AgentDefinition, AgentDefinitionRepositoryPort } from "@tavi/contracts";

/**
 * Agents every workspace has without defining them. A workspace's own definition of the same id wins; a built-in is
 * instructions only, like any definition, so it widens nothing.
 */

/** The browser worker's id, as `agents.spawn` names it. */
export const BROWSER_WORKER_AGENT_ID = "browser";

/**
 * The browser worker: one browsing subgoal, done in its own context so pages
 * never crowd the planner's, and answered as records the planner can compare.
 */
const BROWSER_WORKER_PROMPT = `You are a browser worker. You are given one browsing task — find these flights, these prices, this listing — and you answer it with records, not prose.

- Work in the browser: open the site that has the answer, use its own search form (type into suggesting fields with mode "keys" and pick the suggestion), check each action's \`changes\`, and wait for results to load.
- When the page shows the results, read them with \`browser.extract\` (its records are kept with the task) and a schema for one result, then hold them to the task's constraints with \`findings.check\`. Go to the next page or another site when the task asks for more than one page holds.
- A \`blocked\` page is never your answer: follow its hint. Never try to solve a captcha.
- Answer with a short line on what you searched and where, then the records as a JSON array in a fenced \`json\` block — each with the fields the task asks for and the link where it can be checked — then one line on anything you could not get and why. Never invent a value you did not read on a page.`;

/**
 * The built-in browser worker's profile: the
 * browser, what it reads and keeps, a flight search, page fetches and its plan
 * — nothing else is offered to it — and more steps a turn than a chat, since a
 * site takes many. A workspace's own `browser` definition has neither.
 */
export const BROWSER_WORKER_MAX_STEPS = 40;
const BROWSER_WORKER_TOOL_PREFIXES = ["browser.", "findings.", "travel."];
const BROWSER_WORKER_TOOLS = new Set(["web_fetch", "plan.update", AGENT_PAYLOAD_TOOL_ID, "artifacts.view_image"]);

/**
 * Whether the built-in browser worker uses `toolId`: its own tools, and an approved plugin tool that
 * declares `browserWorker` (read-only, or one a person decides every call of), named in `plugins`.
 */
export function browserWorkerUses(toolId: string, plugins: ReadonlySet<string> = new Set()): boolean {
  return (
    BROWSER_WORKER_TOOLS.has(toolId) || BROWSER_WORKER_TOOL_PREFIXES.some((prefix) => toolId.startsWith(prefix)) || plugins.has(toolId)
  );
}

/** When the built-ins were written: their definitions' fixed version. */
const BUILTIN_AT = "2026-10-08T00:00:00.000Z";

const GENERAL_WORKER_PROMPT = `You are a worker. The chat that started you gave you one self-contained task: do it with the tools you were given, and answer with the result itself, short and complete.

- Say what you could not do and why, rather than guessing.
- Never invent a value you did not compute or read.`;

/** The built-in definition of `agentId` in `workspaceId`, if there is one: the browser worker only while `browser`. */
function builtinAgent(workspaceId: string, agentId: string, browser: boolean): AgentDefinition | undefined {
  if (agentId === GENERAL_WORKER_AGENT_ID)
    return {
      agentId: GENERAL_WORKER_AGENT_ID,
      workspaceId,
      name: "Worker",
      description: "Does one self-contained task the chat hands it and answers with the result",
      systemPrompt: GENERAL_WORKER_PROMPT,
      enabled: true,
      createdAt: BUILTIN_AT,
      updatedAt: BUILTIN_AT,
    };
  if (agentId !== BROWSER_WORKER_AGENT_ID || !browser) return undefined;
  return {
    agentId: BROWSER_WORKER_AGENT_ID,
    workspaceId,
    name: "Browser worker",
    description: "Does one browsing task — a search across a site, a set of dates, a comparison — and answers with records",
    systemPrompt: BROWSER_WORKER_PROMPT,
    enabled: true,
    createdAt: BUILTIN_AT,
    updatedAt: BUILTIN_AT,
  };
}

/**
 * `repository` with the built-ins resolvable by `get`, behind any definition the workspace has of its own. `browser`
 * false (the browser engine disabled), or a check that answers false (its Chromium not installed), leaves the browser
 * worker out: it would be told to browse with no browser. The general worker is always there.
 */
export function withBuiltinAgents(
  repository: AgentDefinitionRepositoryPort,
  browser: boolean | (() => Promise<boolean>) = true,
): AgentDefinitionRepositoryPort {
  return {
    ...repository,
    get: async (workspaceId, agentId) =>
      (await repository.get(workspaceId, agentId)) ??
      builtinAgent(
        workspaceId,
        agentId,
        agentId === BROWSER_WORKER_AGENT_ID && typeof browser === "function" ? await browser().catch(() => false) : browser !== false,
      ),
  };
}
