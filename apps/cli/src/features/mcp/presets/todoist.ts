import type { RiskLevel, ToolEffect } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

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
 * an API token (`todoist-token`) on 9 Nov 2026. Its words a person reads are `t`'s (English by default).
 */
export function todoistPreset(t: CoreT = coreEnglish): McpPreset {
  return {
    id: "todoist",
    /** When the template and its tool list were last checked against Doist's published server. */
    checked: "2026-10-27",
    withdrawnIf: "Doist ends the hosted Todoist MCP server, or changes its address, its sign-in, or its tools' annotations",
    name: "Todoist",
    description: t("mcp.preset.todoist.description"),
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
      summary: t("mcp.preset.todoist.summary"),
      category: "tasks",
      publisher: "Doist",
      accountScope: "owner",
      dataClass: "personal",
      scopes: [],
      tools: {
        "add-tasks": { title: t("mcp.preset.todoist.tool.addTasks") },
        "find-tasks": { title: t("mcp.preset.todoist.tool.findTasks") },
        "find-tasks-by-date": { title: t("mcp.preset.todoist.tool.findTasksByDate") },
        "update-tasks": { title: t("mcp.preset.todoist.tool.updateTasks") },
        "complete-tasks": { title: t("mcp.preset.todoist.tool.completeTasks") },
        "uncomplete-tasks": { title: t("mcp.preset.todoist.tool.uncompleteTasks") },
        "find-projects": { title: t("mcp.preset.todoist.tool.findProjects") },
        "get-overview": { title: t("mcp.preset.todoist.tool.getOverview") },
        "delete-object": { title: t("mcp.preset.todoist.tool.deleteObject"), says: t("mcp.preset.todoist.tool.deleteObject.says") },
      },
      auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] },
    },
    floors: (tool: { readonly name: string; readonly effect: ToolEffect }): { readonly minRisk?: RiskLevel } | undefined =>
      tool.name === "delete-object" && tool.effect !== "read-only" ? { minRisk: "high" } : undefined,
  };
}

export const TODOIST_PRESET: McpPreset = todoistPreset();

/**
 * The same hosted server reached with the person's own Todoist API token
 * (Settings → Integrations → Developer) in place of a sign-in: sent as
 * `Authorization: Bearer <token>`, which the server accepted on 9 Nov 2026
 * (`todoist-mcp-server` 14.0.3). For a person who would rather paste a token
 * than sign in through the browser. Same tools, same floors; the token reaches
 * the whole account, so it is stored encrypted and never shown again.
 */
export function todoistTokenPreset(t: CoreT = coreEnglish): McpPreset {
  const signIn = todoistPreset(t);
  return {
    ...signIn,
    id: "todoist-token",
    checked: "2026-11-09",
    withdrawnIf:
      "Doist ends the hosted Todoist MCP server, changes its address, stops accepting a personal API token as a Bearer header, or changes its tools' annotations",
    name: t("mcp.preset.todoistToken.name"),
    description: t("mcp.preset.todoistToken.description"),
    config: {
      apiToken: {
        type: "credential",
        required: true,
        label: t("mcp.preset.todoistToken.apiToken.label"),
        description: t("mcp.preset.todoistToken.apiToken.description"),
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
      name: t("mcp.preset.todoistToken.name"),
      summary: t("mcp.preset.todoistToken.summary"),
      category: "tasks",
      publisher: "Doist",
      accountScope: "owner",
      dataClass: "personal",
      scopes: [],
      tools: signIn.app?.tools ?? {},
    },
    keySteps: [
      {
        text: t("mcp.preset.todoistToken.keyStep"),
        link: { label: t("mcp.preset.todoistToken.keyStep.link"), url: "https://app.todoist.com/app/settings/integrations/developer" },
      },
    ],
  };
}

export const TODOIST_TOKEN_PRESET: McpPreset = todoistTokenPreset();
