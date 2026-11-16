import { z } from "zod";

import { MCP_PRESET_IDS } from "./mcp-manifest.js";
import { MCP_SANDBOX_STATES } from "./mcp-store.js";

/**
 * The `mcp` command family: the steps
 * specific to an MCP server — probe it, show its review, approve or reject
 * its tools, verify its files. Operator only, like `plugins`: never a tool.
 */

/** The owner setting `mcp.enabled`: `"true"` or `"false"`; absent, `MCP_ENABLED_DEFAULT`. */
export const MCP_ENABLED_SETTING = "mcp.enabled";
/** On by default: an owner that adds no server runs none either way. */
export const MCP_ENABLED_DEFAULT = true;

/** Whether MCP is on, from the owner setting's stored value. */
export function mcpEnabledOf(stored: string | undefined): boolean {
  return stored === undefined ? MCP_ENABLED_DEFAULT : stored === "true";
}

/**
 * The operator's line for a server in `tools.search`'s description: an
 * owner setting per server, `mcp.searchLine.<id>`. Absent, Tavi
 * writes its own from the approved tools' count and names, never the
 * server's text.
 */
export const mcpSearchLineSetting = (pluginId: string): string => `mcp.searchLine.${pluginId}`;
/** The longest line the operator may write. */
export const MCP_SEARCH_LINE_MAX = 300;

/** A loopback origin, the only place a login started here may come back to. */
export const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

const pluginId = z.string().regex(/^mcp\.[a-z][a-z0-9]{0,18}$/, "an MCP server's id is mcp.<name>");
const version = z.string().min(1).max(64);
const toolName = z.string().min(1).max(256);
const sandbox = z.enum(MCP_SANDBOX_STATES);

export const McpPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("probe"),
    pluginId,
    version: version.optional(),
    sandbox: sandbox.optional(),
    workspaceId: z.string().min(1).max(128).optional(),
  }),
  /** `full`: each tool's input and output schemas too, cleaned, as the model is shown them. */
  z.strictObject({ action: z.literal("show"), pluginId, version: version.optional(), full: z.boolean().optional() }),
  z.strictObject({
    action: z.literal("approve"),
    pluginId,
    version,
    effects: z.record(toolName, z.enum(["read-only", "mutating", "external"])).default({}),
    floors: z.record(toolName, z.enum(["low", "medium", "high", "critical"])).default({}),
    timeouts: z.record(toolName, z.number().int().min(1_000).max(600_000)).default({}),
    disabled: z.array(toolName).max(256).default([]),
    /** The sandbox state, given again to confirm a weaker one. */
    sandbox: sandbox.optional(),
  }),
  z.strictObject({ action: z.literal("reject"), pluginId, version }),
  z.strictObject({ action: z.literal("verify"), pluginId, version: version.optional(), full: z.boolean().default(false) }),
  /** `tavi mcp people <id> on|off`: whether other people's chats in the workspace are offered the server's tools. */
  z.strictObject({ action: z.literal("people"), pluginId, on: z.boolean(), workspaceId: z.string().min(1).max(128).default("default") }),
  /** `tavi mcp list`: every server's state, sandbox, pending review, exposure and budget use. */
  z.strictObject({ action: z.literal("list"), workspaceId: z.string().min(1).max(128).default("default") }),
  /**
   * Adding a server from the canvas: a remote one, an npm one, or a preset, written and installed on the owner
   * as a proposed version. A local directory or a system binary is added with `tavi mcp add` only.
   */
  z.strictObject({
    action: z.literal("add"),
    slug: z
      .string()
      .regex(/^[a-z][a-z0-9]{0,18}$/, "a server name is lowercase letters and digits, starting with a letter, at most 19 characters"),
    form: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("url"),
        url: z.string().min(1).max(2048),
        headers: z.array(z.string().min(1).max(512)).max(16).default([]),
        lan: z.boolean().default(false),
        oauth: z.boolean().default(false),
      }),
      z.strictObject({ kind: z.literal("npm"), spec: z.string().min(1).max(256) }),
      z.strictObject({ kind: z.literal("preset"), preset: z.enum(MCP_PRESET_IDS) }),
      /** An MCP Registry entry: the owner reads its server.json again and adds the option named. */
      z.strictObject({
        kind: z.literal("registry"),
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64),
        option: z.string().regex(/^(?:npm|pypi|mcpb|remote)(?:-\d{1,2})?$/),
      }),
    ]),
    name: z.string().min(1).max(80).optional(),
  }),
  /** The Discover view and `tavi mcp search`: a page of the MCP Registry, each entry's ways to add it. */
  z.strictObject({ action: z.literal("search"), query: z.string().max(200).default(""), cursor: z.string().min(1).max(1024).optional() }),
  /** `tavi mcp registry [<url>|--default]`: the registry searched; a page reads it, only the CLI changes it. */
  z.strictObject({ action: z.literal("registry"), url: z.string().min(1).max(2048).optional(), reset: z.boolean().default(false) }),
  /**
   * OAuth: a login started by the operator only (`origin` is the loopback listener the CLI opened, for a
   * redirect back to this computer), its progress, and a logout that revokes and deletes the grant.
   */
  z.strictObject({
    action: z.literal("login"),
    pluginId,
    origin: z.string().regex(LOOPBACK_ORIGIN_PATTERN).optional(),
    /** Where it comes back to: `loopback` needs `origin`; `public`, the owner's https address. Absent, today's choice. */
    via: z.enum(["loopback", "public"]).optional(),
  }),
  z.strictObject({ action: z.literal("login-status"), flowId: z.string().min(1).max(64) }),
  /** Paste-back: the address the browser landed on, for this flow only. */
  z.strictObject({ action: z.literal("login-finish"), flowId: z.string().min(1).max(64), address: z.string().min(1).max(8192) }),
  z.strictObject({ action: z.literal("login-cancel"), flowId: z.string().min(1).max(64) }),
  /** `upstream: false`: forgotten here only, the provider's grant left for another app signed in with it. */
  z.strictObject({ action: z.literal("logout"), pluginId, upstream: z.boolean().optional() }),
  /** `tavi mcp line <id> [<text>|--clear]`: the operator's line for the server in `tools.search`'s description. */
  z.strictObject({
    action: z.literal("line"),
    pluginId,
    text: z
      .string()
      .trim()
      .min(1)
      .max(MCP_SEARCH_LINE_MAX)
      .regex(/^[^\r\n]*$/, "a line is one line")
      .optional(),
  }),
  /** A server's log tail, as `tavi mcp logs` reads it. */
  z.strictObject({ action: z.literal("logs"), pluginId, lines: z.number().int().min(1).max(10_000).default(100) }),
  /** `tavi mcp on|off`: the owner's kill switch; off stops every server and withdraws its tools. */
  z.strictObject({ action: z.literal("switch"), on: z.boolean() }),
]);
export type McpPayload = z.infer<typeof McpPayloadSchema>;
