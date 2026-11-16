import { describe, expect, it } from "vitest";

import {
  IPC_COMMANDS,
  SearchPayloadSchema,
  searchCredentialRefProblem,
  UI_BRIDGE_COMMANDS,
  UI_BRIDGE_REFUSED,
  UiOwnerAnswerSchema,
  UiSessionAnswerSchema,
  UiSessionRequestSchema,
  isUiBridgeCommand,
} from "../src/index.js";

describe("the `tavi ui` bridge's contract", () => {
  it("lets a page reach what it needs and never shutdown, recover or doctor", () => {
    // `mcp` reaches the canvas with its own section; the owner vets its weakening actions.
    // `ideas` reaches the Ideas tab; the owner refuses a page's provider or digest switch.
    // `reports` is the terminal's: the canvas reads briefs as artifacts.
    expect(UI_BRIDGE_REFUSED).toEqual(["recover", "doctor", "shutdown", "router", "reports"]);
    for (const command of UI_BRIDGE_COMMANDS) expect(IPC_COMMANDS).toContain(command);
    // Every IPC command is either allowed or refused: a command added to the
    // contract is refused until it is named here.
    expect([...UI_BRIDGE_COMMANDS, ...UI_BRIDGE_REFUSED].sort()).toEqual([...IPC_COMMANDS].sort());
    expect(isUiBridgeCommand("run")).toBe(true);
    expect(isUiBridgeCommand("shutdown")).toBe(false);
    expect(isUiBridgeCommand("toString")).toBe(false);
    // The live browser view's watch, ack and unwatch.
    expect(isUiBridgeCommand("browser-live")).toBe(true);
  });

  it("bounds the answers a page reads", () => {
    expect(UiOwnerAnswerSchema.safeParse({ sessionId: "s", protocolVersion: 3 }).success).toBe(true);
    expect(UiOwnerAnswerSchema.safeParse({ sessionId: "", protocolVersion: 3 }).success).toBe(false);
    expect(UiSessionAnswerSchema.safeParse({ secret: "x".repeat(129) }).success).toBe(false);
    expect(UiSessionRequestSchema.safeParse({ token: "t".repeat(128) }).success).toBe(true);
    expect(UiSessionRequestSchema.safeParse({ token: "" }).success).toBe(false);
    expect(UiSessionRequestSchema.safeParse({ token: "t".repeat(129) }).success).toBe(false);
  });

  it("forwards the search family, bounded as the provider it writes", () => {
    expect(isUiBridgeCommand("search")).toBe(true);
    expect(
      SearchPayloadSchema.safeParse({ action: "add", providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888" }).success,
    ).toBe(true);
    expect(SearchPayloadSchema.safeParse({ action: "add", providerId: "Home", kind: "searxng" }).success).toBe(false);
    expect(SearchPayloadSchema.safeParse({ action: "add", providerId: "home", kind: "bing" }).success).toBe(false);
    expect(SearchPayloadSchema.safeParse({ action: "test", providerId: "home", query: "q".repeat(501) }).success).toBe(false);
    expect(SearchPayloadSchema.safeParse({ action: "purge" }).success).toBe(false);
    // A provider's key is a search reference: its kind's, or search.* — never a model's or a bot's.
    expect(searchCredentialRefProblem("brave", "brave.apiKey")).toBeUndefined();
    expect(searchCredentialRefProblem("brave", "search.home")).toBeUndefined();
    expect(searchCredentialRefProblem("brave", "serper.apiKey")).toContain("brave.<name>");
    expect(searchCredentialRefProblem("tavily", "openai.apiKey")).toContain("search.<name>");
    expect(searchCredentialRefProblem("serper", "searchy.key")).toBeDefined();
  });
});
