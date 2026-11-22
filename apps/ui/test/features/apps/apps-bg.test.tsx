// @vitest-environment jsdom
import type { ClientResponse } from "@tavi/client/browser";
import type { AppsCatalogAnswer, ConnectableApp } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectedApps, type AppsWhere } from "../../../src/features/apps/ConnectedApps.js";
import { setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mountSettled as mount, unmountAll } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Connected apps in Bulgarian: the page's tabs, the list's groups and health, and Discover's sections. App names and summaries are the owner's. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const app: ConnectableApp = {
  appId: "calendar-app",
  name: "Calendar",
  summary: "Read your schedule.",
  category: "calendar",
  publisher: "Example",
  source: { kind: "mcp", pluginIds: ["mcp.cal"], preset: "calendar-preset", verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "oauth", client: "shared-provider", provider: "example", scopes: [], stepUp: [] },
  tools: [],
  egress: { hosts: ["calendar.example.com"], lan: false, anyNetwork: false },
  credentials: [{ name: "sign-in", raw: false }],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [
    {
      accountId: "mcp.cal",
      label: "you@example.com",
      identity: "you@example.com",
      owner: { kind: "owner" },
      health: "ready",
      grantedScopes: [],
      missingScopes: [],
      signedInAt: "2026-10-16T09:00:00.000Z",
      expiresWeekly: false,
      workspaces: ["default"],
      people: false,
      sharing: "personal",
      readOnly: false,
    },
  ],
  health: "ready",
  repairs: [],
  warnings: [],
};

const CATALOG: AppsCatalogAnswer = {
  sections: [
    {
      section: "presets",
      entries: [
        {
          ref: { kind: "preset", id: "todoist" },
          name: "Todoist",
          summary: "Your tasks.",
          category: "tasks",
          auth: "oauth",
          badges: ["tavi-preset", "remote"],
          installed: false,
          options: [],
        },
      ],
    },
    { section: "installed", entries: [] },
  ],
};

const client: SettingsClient = {
  request: async (command, payload) => {
    const action = (payload as Record<string, unknown>)["action"];
    if (command === "apps" && action === "list") return { ok: true, result: { apps: [app] } } as ClientResponse;
    if (command === "apps" && action === "catalog") return { ok: true, result: { catalog: CATALOG } } as ClientResponse;
    if (command === "apps" && action === "discover")
      return { ok: true, result: { discover: { registry: "https://registry.example", entries: [] } } } as ClientResponse;
    return { ok: true, result: {} } as ClientResponse;
  },
};

const page = (where: AppsWhere) =>
  mount(
    <InWorkspace client={client} workspaceId="default">
      <ConnectedApps where={where} onWhere={() => undefined} />
    </InWorkspace>,
  );

describe("Connected apps in Bulgarian", () => {
  it("heads the page and its tabs, and offers the kill switch", async () => {
    const view = await page({ tab: "connected" });
    const text = view.textContent ?? "";
    expect(text).toContain("Свързани приложения");
    expect(text).toContain("Открий");
    expect(text).toContain("Аварийно спиране: Изключи всички MCP приложения");
    for (const word of ["Connected apps", "Discover", "Connected", "The kill switch", "Turn every MCP app off"])
      expect(text).not.toContain(word);
  });

  it("names Discover's sections", async () => {
    const view = await page({ tab: "discover" });
    const text = view.textContent ?? "";
    expect(text).toContain("Готови от Tavi");
    expect(text).toContain("Добави MCP сървър по адрес или npm пакет");
    for (const word of ["Tavi presets", "Tavi preset", "Remote", "Add an MCP server"]) expect(text).not.toContain(word);
  });
});
