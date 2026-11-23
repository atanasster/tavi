// @vitest-environment jsdom
import type { ClientResponse } from "@tavi/client/browser";
import type { AppsCatalogAnswer, ConnectableApp } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { ConnectedApps, type AppsWhere } from "../../../src/features/apps/ConnectedApps.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mountSettled as mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";
import { inBulgarian } from "../../support/bulgarian.js";
import { calendarAccount, calendarReach } from "../../support/apps.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Connected apps in Bulgarian: the page's tabs, the list's groups and health, and Discover's sections. App names and summaries are the owner's. */

inBulgarian();

const app: ConnectableApp = {
  appId: "calendar-app",
  name: "Calendar",
  summary: "Read your schedule.",
  category: "calendar",
  publisher: "Example",
  source: { kind: "mcp", pluginIds: ["mcp.cal"], preset: "calendar-preset", verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "oauth", client: "shared-provider", provider: "example", scopes: [], stepUp: [] },
  tools: [],
  ...calendarReach,
  accounts: [calendarAccount],
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

  it("says a repair's button and cause in Bulgarian from their keys, and a server's own reason as written", async () => {
    const lapsed: ConnectableApp = {
      ...app,
      health: "needs-sign-in",
      accounts: app.accounts.map((account) => ({ ...account, health: "needs-sign-in" as const })),
      repairs: [
        {
          kind: "sign-in",
          accountId: "mcp.cal",
          title: "Sign in to Calendar again",
          titleRef: { key: "app.repair.signInAgain", params: { app: "Calendar" } },
          detail: "its sign-in expired or was revoked",
          detailRef: { key: "app.repair.signInLapsed" },
          cli: "tavi mcp login mcp.cal",
        },
      ],
    };
    const repairing: SettingsClient = {
      request: async (command, payload) =>
        command === "apps" && (payload as Record<string, unknown>)["action"] === "list"
          ? ({ ok: true, result: { apps: [lapsed] } } as ClientResponse)
          : client.request(command, payload),
    };
    const view = await mount(
      <InWorkspace client={repairing} workspaceId="default">
        <ConnectedApps where={{ tab: "connected" }} onWhere={() => undefined} />
      </InWorkspace>,
    );
    const text = view.textContent ?? "";
    expect(text).toContain("Влез отново в Calendar");
    expect(text).toContain("входът изтече или беше отменен");
    expect(text).not.toContain("Sign in to Calendar again");
  });

  it("names Discover's sections", async () => {
    const view = await page({ tab: "discover" });
    const text = view.textContent ?? "";
    expect(text).toContain("Готови от Tavi");
    expect(text).toContain("Добави MCP сървър по адрес или npm пакет");
    for (const word of ["Tavi presets", "Tavi preset", "Remote", "Add an MCP server"]) expect(text).not.toContain(word);
  });
});
