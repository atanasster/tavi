import { bareIdeasRequest } from "@tavi/plugin-kit/ideas/conformance";
import { IDEA_CATALOGUE } from "@tavi/plugin-kit/ideas";
import type { IdeasGenerateRequest } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createBuiltinIdeasProvider } from "../src/ideas.js";

/** The built-in ideas provider in the workspace's language: the catalogue's words in Bulgarian when it is Bulgarian. */

const bare = (locale?: "bg"): IdeasGenerateRequest => ({
  ...bareIdeasRequest(new AbortController().signal),
  ...(locale === undefined ? {} : { locale }),
});
const english = new Map(IDEA_CATALOGUE.map((template) => [template.key, template]));

describe("the built-in ideas provider in Bulgarian", () => {
  it("writes its catalogue ideas in English byte for byte when no language is named", async () => {
    const { ideas } = await createBuiltinIdeasProvider().generate(bare());
    expect(ideas.length).toBeGreaterThan(0);
    for (const { idea } of ideas) {
      const template = english.get(idea.key)!;
      expect([idea.title, idea.label, idea.pitch, idea.prompt]).toEqual([template.title, template.label, template.pitch, template.prompt]);
    }
  });

  it("writes them in Bulgarian, the same ideas in the same order, when the workspace is Bulgarian", async () => {
    const [{ ideas: inEnglish }, { ideas: inBulgarian }] = await Promise.all([
      createBuiltinIdeasProvider().generate(bare()),
      createBuiltinIdeasProvider().generate(bare("bg")),
    ]);
    expect(inBulgarian.map(({ idea, score }) => [idea.key, score])).toEqual(inEnglish.map(({ idea, score }) => [idea.key, score]));
    for (const { idea } of inBulgarian)
      for (const field of ["title", "label", "pitch", "prompt"] as const) {
        expect(idea[field], `${idea.key}.${field}`).toMatch(/\p{Script=Cyrillic}/u);
        expect(idea[field]).not.toBe(english.get(idea.key)?.[field]);
      }
  });

  it("matches what a person wrote in Bulgarian and cites it", async () => {
    const { ideas } = await createBuiltinIdeasProvider().generate({
      ...bare("bg"),
      memory: [{ recordId: "mem-1", revisionId: "rev-1", kind: "fact", text: "Планира пътуване до Лисабон през май; търси евтини полети" }],
    });
    const fares = ideas.find(({ idea }) => idea.key === "travel.fare-watch");
    expect(fares?.idea.basis).toEqual([
      { kind: "memory", ref: "mem-1", excerpt: "Планира пътуване до Лисабон през май; търси евтини полети" },
    ]);
    expect(fares?.idea.title).toBe("Мога да следя цените на полетите за следващото ти пътуване");
    expect(ideas[0]?.idea.key).toBe("travel.fare-watch");
  });
});
