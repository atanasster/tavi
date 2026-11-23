import { renderTextRef } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import {
  channelAccountRepair,
  mcpAccountRepair,
  pluginRepair,
  weeklySignInReminder,
  type McpAccountFacts,
} from "../../src/features/apps/health.js";

/**
 * A Connected app's repair carries its words by key beside the English it has always shown, so the canvas says its
 * button and its cause in the workspace's language; a server's own reason stays as the server said it.
 */
const bg = coreIn("bg");

const facts = (overrides: Partial<McpAccountFacts> = {}): McpAccountFacts => ({
  pluginId: "mcp.todoist",
  state: "running",
  enabled: true,
  activeVersion: "1.0.0",
  pendingVersions: [],
  waitingTools: 0,
  openNotices: [],
  missingSettings: [],
  oauth: true,
  signedIn: true,
  ...overrides,
});

describe("a Connected app's repair in Bulgarian", () => {
  it("keeps the English byte for byte and says the same repair in Bulgarian", () => {
    const repair = mcpAccountRepair("Todoist", "needs-sign-in", facts({ state: "login-required" }));
    expect(repair?.title).toBe("Sign in to Todoist again");
    expect(repair?.detail).toBe("its sign-in expired or was revoked");
    expect(renderTextRef(repair?.titleRef ?? { key: "" }, bg)).toBe("Влез отново в Todoist");
    expect(renderTextRef(repair?.detailRef ?? { key: "" }, bg)).toBe("входът изтече или беше отменен");
  });

  it("names every missing setting, joined the Bulgarian way", () => {
    const repair = mcpAccountRepair(
      "Google Maps",
      "not-set-up",
      facts({
        missingSettings: ["apiKey", "city"],
        fields: { apiKey: { label: "Your Maps API key", type: "credential" }, city: { type: "string" } },
      }),
    );
    expect(repair?.detail).toBe("It needs your Maps API key and city.");
    expect(renderTextRef(repair?.titleRef ?? { key: "" }, bg)).toBe("Довърши настройката на Google Maps");
    expect(renderTextRef(repair?.detailRef ?? { key: "" }, bg)).toBe("Липсва: your Maps API key и city.");
  });

  it("writes a possessive in English and a plain name in Bulgarian", () => {
    const repair = mcpAccountRepair("Notes", "needs-review", facts({ waitingTools: 2 }));
    expect(repair?.title).toBe("Review Notes' tools");
    expect(repair?.detail).toBe("2 of its tools are new or changed and won't be used until you review them.");
    expect(renderTextRef(repair?.titleRef ?? { key: "" }, bg)).toBe("Прегледай инструментите на Notes");
    expect(renderTextRef(repair?.detailRef ?? { key: "" }, bg)).toBe(
      "2 от инструментите му са нови или променени и няма да се ползват, докато не ги прегледаш.",
    );
    const one = mcpAccountRepair("Notes", "needs-review", facts({ waitingTools: 1 }));
    expect(one?.detail).toBe("1 of its tools are new or changed and won't be used until you review them.");
    expect(renderTextRef(one?.detailRef ?? { key: "" }, bg)).toBe(
      "1 от инструментите му е нов или променен и няма да се ползва, докато не го прегледаш.",
    );
  });

  it("shows a server's own reason as it said it, with no key", () => {
    const repair = mcpAccountRepair("Todoist", "error", facts({ state: "failed", reason: "ECONNREFUSED" }));
    expect(repair?.detail).toBe("ECONNREFUSED");
    expect(repair?.detailRef).toBeUndefined();
    expect(renderTextRef(repair?.titleRef ?? { key: "" }, bg)).toBe("Todoist спря да работи");
  });

  it("says a channel's, a plugin's and a weekly sign-in's repair in Bulgarian", () => {
    const channel = channelAccountRepair("Discord", "needs-sign-in", "c-1", "token");
    expect(channel?.title).toBe("Paste a new Discord token");
    expect(renderTextRef(channel?.titleRef ?? { key: "" }, bg)).toBe("Постави нов токен за Discord");
    const plugin = pluginRepair("Jobs", "acme.jobs", "paused", []);
    expect(renderTextRef(plugin?.titleRef ?? { key: "" }, bg)).toBe("Включи Jobs");
    expect(renderTextRef(plugin?.detailRef ?? { key: "" }, bg)).toBe("Изключено е.");
    const weekly = weeklySignInReminder("Gmail", "mcp.gmail", "2026-10-16T09:00:00.000Z", "2026-10-15T10:00:00.000Z");
    expect(weekly?.title).toBe("Sign in to Gmail again by 2026-10-16");
    expect(renderTextRef(weekly?.titleRef ?? { key: "" }, bg)).toBe("Влез отново в Gmail до 2026-10-16");
    expect(renderTextRef(weekly?.detailRef ?? { key: "" }, bg)).toContain("7 дни");
  });
});
