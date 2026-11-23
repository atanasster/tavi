import type { InvocationContext, ToolRegistrar } from "@tavi/contracts";
import { partialFake } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { registerFlightsTools } from "../src/index.js";

/** Flight search's approval card in the workspace's language; what the model reads stays English. */

function assessed(locale: ((workspaceId: string) => "en" | "bg" | undefined) | undefined, workspaceId = "default") {
  let tool: Parameters<ToolRegistrar["register"]>[0] | undefined;
  registerFlightsTools(partialFake<ToolRegistrar>({ register: (definition) => void (tool = definition) }), {
    search: async () => ({ content: {} }) as never,
    now: () => "t",
    ...(locale === undefined ? {} : { locale }),
  });
  const context = partialFake<InvocationContext>({ workspaceId });
  return { assessment: tool?.assess?.({ from: "SOF", to: "LHR" }, context), description: tool?.description };
}

describe("travel.flights_search's approval card", () => {
  it("is said in Bulgarian in a Bulgarian workspace", () => {
    expect(assessed(() => "bg").assessment).toMatchObject({
      display: {
        title: "Търси полети SOF → LHR",
        detail: "Изпраща пътуването (места, дати, пътници) на търсачката за полети на Kiwi.com и на Google Flights, ако е включен",
      },
      reasons: ["изпраща пътуването на търсачката за полети на Kiwi.com и на Google Flights"],
    });
    // The model's description is the reviewed English.
    expect(assessed(() => "bg").description).toBe(assessed(undefined).description);
  });

  it("follows the call's own workspace, not the default one", () => {
    const languages = (workspaceId: string) => (workspaceId === "other" ? ("bg" as const) : ("en" as const));
    expect(assessed(languages, "other").assessment?.display.title).toBe("Търси полети SOF → LHR");
    expect(assessed(languages, "default").assessment?.display.title).toBe("Search flights SOF → LHR");
  });

  it("is English byte for byte with no language, or English", () => {
    for (const locale of [undefined, () => "en" as const, () => undefined])
      expect(assessed(locale).assessment).toMatchObject({
        display: {
          title: "Search flights SOF → LHR",
          detail: "Sends the trip (places, dates, passengers) to Kiwi.com's flight search, and to Google Flights where that is on",
        },
        reasons: ["sends the trip to Kiwi.com's flight search and to Google Flights"],
      });
  });
});
