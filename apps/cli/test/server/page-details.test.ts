import { TaviError } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { channelsPageDetails, mcpPageDetails } from "../../src/server/config-commands.js";

/** The facts of an owner's refusal a page is given beside its words, and no others. */
describe("a refusal's details for the page", () => {
  it("keeps a server's refusal of its credentials, so Connected apps can offer the key again (QA 2061)", () => {
    const refused = new TaviError("NOT_AUTHORIZED", "the MCP server refused its credentials (HTTP 401, connect)", {
      details: { mcpFailure: "auth", where: "connect", status: 401 },
    });
    expect(mcpPageDetails(refused)).toEqual({ mcpFailure: "auth", status: 401 });
    expect(mcpPageDetails(new TaviError("UNAVAILABLE", "down", { details: { mcpFailure: "server", where: "connect" } }))).toBeUndefined();
    expect(
      mcpPageDetails(new TaviError("NOT_AUTHORIZED", "login", { details: { needsClient: true, redirect: "http://127.0.0.1/cb", x: 1 } })),
    ).toEqual({ needsClient: true, redirect: "http://127.0.0.1/cb" });
  });

  it("keeps that a channel isn't running, and its name, so the page says so in its own words (QA 2033)", () => {
    const stopped = new TaviError("NOT_CONFIGURED", "Telegram isn't running: …", {
      details: { notListening: true, label: "Telegram", token: "secret" },
    });
    expect(channelsPageDetails(stopped)).toEqual({ notListening: true, label: "Telegram" });
    expect(channelsPageDetails(new TaviError("NOT_FOUND", "no such connection"))).toBeUndefined();
  });
});
