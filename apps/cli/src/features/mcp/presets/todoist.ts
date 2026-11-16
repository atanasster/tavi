import type { RiskLevel, ToolEffect } from "@tavi/contracts";

import type { McpPreset } from "./index.js";

/**
 * Todoist's official hosted MCP server (`https://ai.todoist.net/mcp`,
 * Streamable HTTP, from Doist's `todoist-ai`): the task home R5 points
 * people with a task app at (`tasks.home: "mcp:todoist"`). OAuth with no
 * client of the person's own: the client registers itself, so connecting is
 * one sign-in.
 *
 * Its tools are named in kebab case (`add-tasks`, `find-tasks`,
 * `complete-tasks`, `delete-object` …; about fifty on 9 Nov 2026), and carry
 * their own annotations, which the preset keeps: Todoist marks adding tasks,
 * comments and reminders open-world, so those are suggested `external`.
 * `delete-object` removes a task, a project, a section or a comment for good,
 * so it keeps a `high` floor. Walked end to end against the live server with
 * an API token (`todoist-token`) on 9 Nov 2026.
 */
export const TODOIST_PRESET: McpPreset = {
  id: "todoist",
  /** When the template and its tool list were last checked against Doist's published server. */
  checked: "2026-10-27",
  withdrawnIf: "Doist ends the hosted Todoist MCP server, or changes its address, its sign-in, or its tools' annotations",
  name: "Todoist",
  description: "Your Todoist tasks and projects, through Doist's official hosted MCP server: Tavi's task home when you keep tasks there.",
  // One Todoist: the token preset is the other way into this server, and adding one switches the other.
  wayInto: "todoist",
  config: {},
  block: {
    transport: "http",
    url: { value: "https://ai.todoist.net/mcp" },
    auth: "oauth",
    exposure: "auto",
  },
  app: {
    id: "todoist",
    name: "Todoist",
    summary: "Add, find, change and complete your Todoist tasks, asking before anything is deleted.",
    category: "tasks",
    publisher: "Doist",
    accountScope: "owner",
    dataClass: "personal",
    scopes: [],
    tools: {
      "add-tasks": { title: "Add tasks" },
      "find-tasks": { title: "Find tasks" },
      "find-tasks-by-date": { title: "Find tasks by date" },
      "update-tasks": { title: "Change tasks" },
      "complete-tasks": { title: "Complete tasks" },
      "uncomplete-tasks": { title: "Reopen tasks" },
      "find-projects": { title: "Find projects" },
      "get-overview": { title: "Overview" },
      "delete-object": { title: "Delete", says: "Deletes a task, project, section or comment for good" },
    },
    auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] },
  },
  floors: (tool: { readonly name: string; readonly effect: ToolEffect }): { readonly minRisk?: RiskLevel } | undefined =>
    tool.name === "delete-object" && tool.effect !== "read-only" ? { minRisk: "high" } : undefined,
};

/**
 * The same hosted server reached with the person's own Todoist API token
 * (Settings → Integrations → Developer) in place of a sign-in: sent as
 * `Authorization: Bearer <token>`, which the server accepted on 9 Nov 2026
 * (`todoist-mcp-server` 14.0.3). For a person who would rather paste a token
 * than sign in through the browser. Same tools, same floors; the token reaches
 * the whole account, so it is stored encrypted and never shown again.
 */
export const TODOIST_TOKEN_PRESET: McpPreset = {
  ...TODOIST_PRESET,
  id: "todoist-token",
  checked: "2026-11-09",
  withdrawnIf:
    "Doist ends the hosted Todoist MCP server, changes its address, stops accepting a personal API token as a Bearer header, or changes its tools' annotations",
  name: "Todoist (API token)",
  description:
    "Your Todoist tasks and projects through Doist's official hosted MCP server, reached with your own Todoist API token instead of a sign-in.",
  config: {
    apiToken: {
      type: "credential",
      required: true,
      label: "Your Todoist API token",
      description: "Your Todoist API token (Todoist → Settings → Integrations → Developer)",
    },
  },
  block: {
    transport: "http",
    url: { value: "https://ai.todoist.net/mcp" },
    headers: { Authorization: { prefix: "Bearer ", setting: "apiToken" } },
    auth: "headers",
    exposure: "auto",
  },
  app: {
    id: "todoist-token",
    name: "Todoist (API token)",
    summary:
      "Todoist with your own API token instead of a sign-in: add, find, change and complete tasks, asking before anything is deleted.",
    category: "tasks",
    publisher: "Doist",
    accountScope: "owner",
    dataClass: "personal",
    scopes: [],
    tools: TODOIST_PRESET.app?.tools ?? {},
  },
  keySteps: [
    {
      text: "In Todoist, open Settings → Integrations → Developer and copy your API token. It reaches your whole account: keep it to yourself, and issue a new one there to cut Tavi off.",
      link: { label: "Open Todoist's settings", url: "https://app.todoist.com/app/settings/integrations/developer" },
    },
  ],
};
