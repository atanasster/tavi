// @vitest-environment jsdom
import type { SearchProviderConfig } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { WebSearchSettings } from "../../../src/features/settings/WebSearchSettings.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount, unmountAll } from "../../support/dom.js";

/** Settings → Web search: each provider's row, as the owner lists them. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-11-19T00:00:00.000Z";
const providers: SearchProviderConfig[] = [
  { providerId: "tavily", kind: "tavily", enabled: true, createdAt: at, updatedAt: at },
  { providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: false, createdAt: at, updatedAt: at },
] as SearchProviderConfig[];

function owner(answer: Record<string, unknown>): SettingsClient {
  return { request: () => Promise.resolve({ ok: true, result: answer } as never) };
}

afterEach(unmountAll);

describe("Settings → Web search", () => {
  it("names a provider's instance after a separator, its disabled state as a status, and its actions as text buttons", async () => {
    const view = await mount(
      <InWorkspace client={owner({ providers })}>
        <WebSearchSettings />
      </InWorkspace>,
    );
    const rows = [...view.querySelectorAll(".rows > .row")];
    expect(rows[0]?.textContent).toContain("Tavily · no key needed");
    expect(rows[1]?.textContent).toContain("SearXNG home · http://127.0.0.1:8888");
    expect(rows[1]?.querySelector(".badge")?.textContent).toBe("disabled");
    expect(rows[0]?.querySelector('button[aria-label="Test tavily"]')?.className).toContain("ghost");
    expect(rows[0]?.querySelector('button[aria-label="Disable tavily"]')?.className).toContain("ghost");
    // A file and a command, set as code rather than breaking at the file name's hyphen as prose.
    expect([...view.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["web-providers.json", "tavi serve"]);
  });

  it("sets the commands of a long or partly unreadable list as code, not literal backticks", async () => {
    const view = await mount(
      <InWorkspace client={owner({ providers, truncated: true, unreadable: ["broken"] })}>
        <WebSearchSettings />
      </InWorkspace>,
    );
    expect(view.textContent).not.toContain("`");
    const codes = [...view.querySelectorAll("code")].map((code) => code.textContent);
    expect(codes).toContain("tavi search list");
    expect(codes).toContain("tavi search remove");
  });
});
