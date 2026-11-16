// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";
import type { AppsCatalogAnswer, ConnectableApp } from "@tavi/contracts";

import { ConnectedApps, type AppsWhere } from "../../../src/features/apps/ConnectedApps.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { settle } from "../../support/dom.js";

/**
 * No per-app UI code: three apps Tavi
 * knows nothing about — an external plugin with an `apps` block, another
 * without one, a registry MCP server — drawn in Discover and Connected from
 * what the owner's projection answered for them (`fixtures/generic-apps.json`,
 * kept equal to it by `apps/cli/test/apps/apps-generic.test.ts`), with the canvas's
 * code as it is.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "generic-apps.json"), "utf8")) as {
  readonly apps: readonly ConnectableApp[];
  readonly catalog: AppsCatalogAnswer;
};

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

const client: SettingsClient = {
  request: async (command, payload) => {
    const body = payload as Record<string, unknown>;
    if (command === "apps" && body["action"] === "list") return { ok: true, result: { apps: FIXTURE.apps } } as ClientResponse;
    if (command === "apps" && body["action"] === "show")
      return { ok: true, result: { app: FIXTURE.apps.find((app) => app.appId === body["appId"]) } } as ClientResponse;
    if (command === "apps" && body["action"] === "catalog") return { ok: true, result: { catalog: FIXTURE.catalog } } as ClientResponse;
    if (command === "apps" && body["action"] === "activity")
      return { ok: true, result: { activity: { rows: [], readsListed: true } } } as ClientResponse;
    return { ok: true, result: {} } as ClientResponse;
  },
};

function Harness({ start }: { readonly start: AppsWhere }) {
  const [where, setWhere] = useState(start);
  return (
    <InWorkspace client={client} workspaceId="default">
      <ConnectedApps where={where} onWhere={setWhere} />
    </InWorkspace>
  );
}

async function page(where: AppsWhere): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness start={where} />));
  await settle();
  return host;
}

describe("apps Tavi knows nothing about, on the canvas", () => {
  it("lists all three in Connected, each under its health with its fix", async () => {
    const view = await page({ tab: "connected" });
    const sections = Object.fromEntries(
      [...view.querySelectorAll("h2")].map((heading) => [heading.textContent, heading.closest("section")?.textContent ?? ""]),
    );
    expect(sections["Needs you"]).toContain("docs");
    expect(sections["Needs you"]).toContain("Weather");
    expect(sections["Connected"]).toContain("Acme Notes");
    // Its icon from the approved snapshot; the others draw two letters.
    expect([...view.querySelectorAll(".apps-icon img")].map((icon) => icon.getAttribute("src"))).toEqual([
      FIXTURE.apps.find((app) => app.appId === "acme-notes")?.icon,
    ]);
    for (const app of FIXTURE.apps) for (const repair of app.repairs) expect(view.textContent).toContain(repair.title);
  });

  it("shows each one's page with its tools, as the owner titled them", async () => {
    for (const app of FIXTURE.apps) {
      const view = await page({ tab: "connected", appId: app.appId });
      expect(view.querySelector("h1")?.textContent).toContain(app.name);
      // Each tool by the title the owner gave it, in its own place (not found in some description).
      expect([...view.querySelectorAll(".apps-tool-name strong")].map((title) => title.textContent)).toEqual(
        app.tools.map((tool) => tool.title),
      );
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("lists in Discover the two not yet set up, each as its own card, and not the one already connected", async () => {
    const view = await page({ tab: "discover" });
    const section = view.querySelector("#apps-section-installed")?.closest("section");
    const cards = [...(section?.querySelectorAll("article") ?? [])].map((card) => card.getAttribute("aria-label"));
    expect(cards.sort()).toEqual(["Weather", "docs"]);
    // Acme Notes is set up: Discover lists what is installed but not set up, so it is in Connected instead.
    expect(view.querySelector('article[aria-label="Acme Notes"]')).toBeNull();
  });
});
