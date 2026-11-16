import { describe, expect, it } from "vitest";

import { appsAnswerText } from "../../src/features/apps/text.js";

/** `tavi apps` answers in words: the app named as Connected apps names it. */
describe("apps answer text", () => {
  it("names the Google app's saved client by the app's name, not its channel id", () => {
    expect(
      appsAnswerText({ action: "configure", workspaceId: "default", appId: "gmail" } as never, {
        configured: { appId: "gmail", accountId: "gmail-1" },
      }),
    ).toBe("Google's OAuth client is saved\n");
  });

  it("sends a keyed app to its key, and only a signed-in app to tavi apps connect", () => {
    const add = (appId: string, pluginId: string) =>
      appsAnswerText({ action: "add", workspaceId: "default" } as never, { added: { appId, pluginId } });
    expect(add("google-maps", "mcp.gmaps")).toBe(
      [
        "added google-maps (mcp.gmaps); give it your Maps API key in Settings → Connected apps, or:",
        "  tavi credentials set plugins.mcp.gmaps.apiKey --file <file>",
        "  tavi plugins config mcp.gmaps --set apiKey=plugins.mcp.gmaps.apiKey",
        "",
      ].join("\n"),
    );
    expect(add("todoist", "mcp.todoist")).toBe("added todoist (mcp.todoist); connect it: tavi apps connect todoist\n");
  });

  it("heads an app once by its name, adding its id only when the name doesn't already say it (QA 2092)", () => {
    const show = (name: string, appId: string) =>
      appsAnswerText({ action: "show", workspaceId: "default", appId } as never, {
        app: {
          name,
          appId,
          health: "paused",
          summary: "s",
          accounts: [],
          tools: [],
          egress: { anyNetwork: false, hosts: [] },
          trust: { output: "untrusted", confidentiality: "public" },
          repairs: [],
          warnings: [],
        },
      }).split("\n")[0];
    expect(show("Email (Mailgun)", "mailgun")).toBe("Email (Mailgun): paused");
    expect(show("Google Maps", "google-maps")).toBe("Google Maps (google-maps): paused");
  });
});
