import type { AppCategory, RiskLevel } from "@tavi/contracts";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";

import type { McpPreset } from "./index.js";

/**
 * Vendors' own hosted MCP servers that sign in with OAuth and register their
 * client themselves, so connecting is one sign-in with no client of the
 * person's own. Each was checked against its live server on 8 Nov 2026: its
 * 401 names its protected-resource metadata, its authorization server's
 * issuer matches, it advertises PKCE (S256) and dynamic client registration.
 * Their tools keep their own annotations and no floor is added, but for Stripe,
 * whose writes move money: each is high at least. The review at approval sets
 * what each may do. No end-to-end run against a real account is
 * recorded yet.
 */
function hosted(
  id: "linear" | "notion" | "sentry" | "stripe" | "figma",
  app: {
    readonly name: string;
    readonly publisher: string;
    readonly url: string;
    readonly category: AppCategory;
    /** Its summary's key: `t` says it. */
    readonly summary: CoreKey;
    /** A floor on every tool that changes something, for an account that moves money. */
    readonly writeFloor?: RiskLevel;
  },
  t: CoreT,
): McpPreset {
  return {
    id,
    checked: "2026-11-08",
    withdrawnIf: `${app.publisher} ends its hosted MCP server, changes its address, or stops registering clients itself`,
    name: app.name,
    description: t("mcp.preset.hosted.description", { name: app.name, publisher: app.publisher }),
    config: {},
    block: { transport: "http", url: { value: app.url }, auth: "oauth", exposure: "auto" },
    app: {
      id,
      name: app.name,
      summary: t(app.summary),
      category: app.category,
      publisher: app.publisher,
      accountScope: "owner",
      dataClass: "personal",
      scopes: [],
      tools: {},
      auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] },
    },
    floors: (tool) => (app.writeFloor !== undefined && tool.effect !== "read-only" ? { minRisk: app.writeFloor } : undefined),
  };
}

const LINEAR_PRESET = (t: CoreT): McpPreset =>
  hosted(
    "linear",
    {
      name: "Linear",
      publisher: "Linear",
      url: "https://mcp.linear.app/mcp",
      category: "tasks",
      summary: "mcp.preset.linear.summary",
    },
    t,
  );

const NOTION_PRESET = (t: CoreT): McpPreset =>
  hosted(
    "notion",
    {
      name: "Notion",
      publisher: "Notion",
      url: "https://mcp.notion.com/mcp",
      category: "notes",
      summary: "mcp.preset.notion.summary",
    },
    t,
  );

const SENTRY_PRESET = (t: CoreT): McpPreset =>
  hosted(
    "sentry",
    {
      name: "Sentry",
      publisher: "Sentry",
      url: "https://mcp.sentry.dev/mcp",
      category: "dev",
      summary: "mcp.preset.sentry.summary",
    },
    t,
  );

const STRIPE_PRESET = (t: CoreT): McpPreset =>
  hosted(
    "stripe",
    {
      name: "Stripe",
      publisher: "Stripe",
      url: "https://mcp.stripe.com",
      category: "business",
      summary: "mcp.preset.stripe.summary",
      writeFloor: "high",
    },
    t,
  );

const FIGMA_PRESET = (t: CoreT): McpPreset =>
  hosted(
    "figma",
    {
      name: "Figma",
      publisher: "Figma",
      url: "https://mcp.figma.com/mcp",
      category: "files",
      summary: "mcp.preset.figma.summary",
    },
    t,
  );

/** Every hosted preset in Discover's order, its words a person reads in `t`'s language (English by default). */
export function hostedPresets(t: CoreT = coreEnglish): readonly McpPreset[] {
  return [LINEAR_PRESET(t), NOTION_PRESET(t), SENTRY_PRESET(t), STRIPE_PRESET(t), FIGMA_PRESET(t)];
}

/** Every hosted preset, in Discover's order. */
export const HOSTED_PRESETS: readonly McpPreset[] = hostedPresets();
