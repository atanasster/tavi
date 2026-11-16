import { readFileSync } from "node:fs";

import { IDEA_CAPABILITIES, IdeaDraftSchema, type IdeaCapability } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { availableTemplates, catalogueIdea, IDEA_CATALOGUE, triggerScore } from "../../src/ideas/catalogue.js";

/** The idea catalogue: one template per runnable use case of the scorecard (fixtures/use-case-scorecard.md). */

const scorecard = readFileSync(new URL("./fixtures/use-case-scorecard.md", import.meta.url), "utf8");
/** The scorecard's rows: `| 6.1 Fare watcher | A | … |`, and `9.1–9.5` for a range. */
const scores = new Map<string, string>();
for (const [, from, to, score] of scorecard.matchAll(/^\| (\d+\.\d+)(?:–(\d+\.\d+))? [^|]+\| ([ABCX]) \|/gmu)) {
  const [domain, first] = from!.split(".").map(Number);
  const last = to === undefined ? first! : Number(to.split(".")[1]);
  for (let index = first!; index <= last; index += 1) scores.set(`${domain}.${index}`, score!);
}

describe("idea catalogue", () => {
  it("reads the scorecard", () => {
    expect(scores.size).toBe(67);
  });

  it("has one template for every use case scored A or B, and none for X", () => {
    const runnable = [...scores]
      .filter(([, score]) => score === "A" || score === "B")
      .map(([id]) => id)
      .sort();
    expect(IDEA_CATALOGUE.map((template) => template.useCase).sort()).toEqual(runnable);
  });

  it("every template is a valid idea on its own", () => {
    for (const template of IDEA_CATALOGUE) {
      const parsed = IdeaDraftSchema.safeParse(catalogueIdea(template));
      expect(parsed.success, `${template.useCase}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it("keys are unique and start with their section, and asks name only what a template requires", () => {
    expect(new Set(IDEA_CATALOGUE.map((template) => template.key)).size).toBe(IDEA_CATALOGUE.length);
    for (const template of IDEA_CATALOGUE) {
      for (const capability of template.requires) expect(IDEA_CAPABILITIES).toContain(capability);
      for (const capability of template.asks ?? []) expect(template.requires).toContain(capability);
      for (const trigger of template.triggers) expect(trigger).toBe(trigger.toLowerCase());
      expect(template.key.split(".")[0], template.useCase).toBe(template.category);
      expect(template.triggers.length).toBeGreaterThan(0);
    }
  });

  it("a catalogue idea cites its use case and marks the uses that ask", () => {
    const inbox = IDEA_CATALOGUE.find((template) => template.useCase === "8.3")!;
    expect(catalogueIdea(inbox)).toMatchObject({
      basis: [{ kind: "general", ref: "8.3" }],
      uses: [{ capability: "mailbox", approval: true }],
    });
  });

  it("offers only templates whose every requirement is available", () => {
    const basics = new Set<IdeaCapability>(["web", "memory", "reminders"]);
    const offered = availableTemplates(basics);
    expect(offered.length).toBeGreaterThan(0);
    for (const template of offered) for (const capability of template.requires) expect(basics.has(capability)).toBe(true);
    expect(offered.some((template) => template.useCase === "6.1")).toBe(false);
  });

  it("a recurring template's prompt does the check now and leaves the watching to Make it recurring", () => {
    // A prompt that also asks to keep watching sends the chat looking for routines and heartbeats, and ends on a
    // proposal the person did not ask for yet; the card offers the recurring part on its own.
    const ongoing = /\b(keep (watching|checking|an eye)|regularly|set up a watch|tell me when|every (day|week|morning)|track)\b/iu;
    const recurring = IDEA_CATALOGUE.filter((template) => template.cadence !== undefined);
    expect(recurring.length).toBeGreaterThan(0);
    expect(recurring.filter((template) => ongoing.test(template.prompt)).map((template) => template.key)).toEqual([]);
  });

  it("makes a routine only of a watch: a card that is no search for what's new has no cadence", () => {
    // A recurring card becomes the news research routine, which a daily outfit or a lost pet can't use.
    const notWatches = ["health-home.lost-pet", "shopping.outfit", "productivity.morning-brief"];
    expect(IDEA_CATALOGUE.filter((template) => notWatches.includes(template.key) && template.cadence !== undefined)).toEqual([]);
  });

  it("scores triggers as whole words and phrases", () => {
    const fares = IDEA_CATALOGUE.find((template) => template.useCase === "6.1")!;
    expect(triggerScore(fares, "Planning a TRIP to Lisbon; need flights.")).toBe(2);
    expect(triggerScore(fares, "tripod and airfare")).toBe(0);
    const rental = IDEA_CATALOGUE.find((template) => template.useCase === "11.1")!;
    expect(triggerScore(rental, "We're house hunting in Sofia")).toBe(1);
  });
});
