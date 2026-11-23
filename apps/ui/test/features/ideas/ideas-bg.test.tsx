// @vitest-environment jsdom
import type { IdeasListAnswer } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { IdeasPage } from "../../../src/features/ideas/IdeasPage.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { flush, settledBy } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";
import { inBulgarian } from "../../support/bulgarian.js";
import { IDEA_AT, idea } from "../../support/rows.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Ideas tab in Bulgarian: its heading, its sections' controls, a card's Why and Try, and its footer. An idea's own words are the owner's. */

const { mount } = settledBy(() => flush());

inBulgarian();

const AT = IDEA_AT;

const list = (answer: Partial<IdeasListAnswer>): SettingsClient => ({
  request: (async (command: string, payload: Record<string, unknown>) => {
    if (command === "ideas" && payload["action"] === "list")
      return {
        ok: true,
        result: {
          ideas: [],
          mutedCategories: [],
          excludedBasis: [],
          provider: "tavi.ideasagent",
          providers: [],
          lastRun: {
            id: "run-1",
            workspaceId: "default",
            trigger: "schedule",
            startedAt: AT,
            outcome: "generated",
            generated: 1,
            dropped: 0,
            tokens: 0,
            usd: 0,
          },
          nextAt: "2026-10-20T05:00:00.000Z",
          modelSet: true,
          ...answer,
        },
      };
    return { ok: true, result: {} };
  }) as SettingsClient["request"],
});

const page = (client: SettingsClient) =>
  mount(
    <InWorkspace client={client} workspaceId="default" timeZone="UTC">
      <IdeasPage onTry={() => undefined} />
    </InWorkspace>,
  );

describe("the Ideas tab in Bulgarian", () => {
  it("heads the page and its first section, offers Try, says why and ends the page", async () => {
    const ideas = [
      idea("travel.fare-watch", { basis: [{ kind: "memory", ref: "mem-1", excerpt: "Lisbon in May" }] }),
      ...["a", "b", "c", "d", "e"].map((name) => idea(`travel.${name}`)),
    ];
    const shown = await page(list({ ideas }));
    const text = shown.textContent ?? "";
    expect(shown.querySelector("h1")?.textContent?.trim()).toBe("Идеи");
    expect([...shown.querySelectorAll("h2")].map((heading) => heading.textContent)).toContain("За теб");
    expect(text).toContain("Опитай");
    expect(text).toContain("Защо:");
    expect(text).toContain("каза „Lisbon in May“");
    expect(text).toContain("Обнови");
    expect(text).toContain("Засега това е всичко.");
    for (const word of ["For you", "Try it", "Why this:", "you said", "Refresh", "That’s all for now.", "Last looked", "Uses:"])
      expect(text).not.toContain(word);
  });

  it("says there are no ideas yet", async () => {
    const shown = await page(list({ ideas: [] }));
    expect(shown.textContent).toContain("Още няма идеи.");
    expect(shown.textContent).not.toContain("No ideas yet.");
  });
});
