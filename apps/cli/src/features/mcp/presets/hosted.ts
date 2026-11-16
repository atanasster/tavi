import type { AppCategory, RiskLevel } from "@tavi/contracts";

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
    readonly summary: string;
    /** A floor on every tool that changes something, for an account that moves money. */
    readonly writeFloor?: RiskLevel;
  },
): McpPreset {
  return {
    id,
    checked: "2026-11-08",
    withdrawnIf: `${app.publisher} ends its hosted MCP server, changes its address, or stops registering clients itself`,
    name: app.name,
    description: `Your ${app.name} account, through ${app.publisher}'s official hosted MCP server: one sign-in, no client of your own.`,
    config: {},
    block: { transport: "http", url: { value: app.url }, auth: "oauth", exposure: "auto" },
    app: {
      id,
      name: app.name,
      summary: app.summary,
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

const LINEAR_PRESET = hosted("linear", {
  name: "Linear",
  publisher: "Linear",
  url: "https://mcp.linear.app/mcp",
  category: "tasks",
  summary: "Find, create and update your Linear issues and projects.",
});

const NOTION_PRESET = hosted("notion", {
  name: "Notion",
  publisher: "Notion",
  url: "https://mcp.notion.com/mcp",
  category: "notes",
  summary: "Search, read and write the Notion pages and databases you share with it.",
});

const SENTRY_PRESET = hosted("sentry", {
  name: "Sentry",
  publisher: "Sentry",
  url: "https://mcp.sentry.dev/mcp",
  category: "dev",
  summary: "Look into your Sentry issues, events and projects.",
});

const STRIPE_PRESET = hosted("stripe", {
  name: "Stripe",
  publisher: "Stripe",
  url: "https://mcp.stripe.com",
  category: "business",
  summary: "Look up and manage your Stripe customers, payments and invoices.",
  writeFloor: "high",
});

const FIGMA_PRESET = hosted("figma", {
  name: "Figma",
  publisher: "Figma",
  url: "https://mcp.figma.com/mcp",
  category: "files",
  summary: "Read your Figma designs: their frames, components and variables.",
});

/** Every hosted preset, in Discover's order. */
export const HOSTED_PRESETS: readonly McpPreset[] = [LINEAR_PRESET, NOTION_PRESET, SENTRY_PRESET, STRIPE_PRESET, FIGMA_PRESET];
