import { describeIdeasProviderConformance, fullIdeasRequest, bareIdeasRequest } from "@tavi/plugin-kit/ideas/conformance";
import { IDEA_CATEGORIES, IdeasProviderError, type IdeasGenerateRequest } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createBuiltinIdeasProvider, REWORD_SYSTEM, TRIAGE_SYSTEM } from "../src/ideas.js";

/** The built-in ideas provider: catalogue templates the census can run, ranked by what the person mentioned. */

describeIdeasProviderConformance("tavi.ideasagent", () => createBuiltinIdeasProvider());

describe("the built-in ideas provider", () => {
  it("ranks what the person mentioned first, citing where they said it", async () => {
    const { ideas } = await createBuiltinIdeasProvider().generate(fullIdeasRequest(new AbortController().signal));
    const keys = ideas.map(({ idea }) => idea.key);
    const fares = ideas.find(({ idea }) => idea.key === "travel.fare-watch");
    expect(fares?.idea.basis).toEqual([{ kind: "memory", ref: "mem-1", excerpt: "Planning a trip to Lisbon in May; wants cheap flights" }]);
    expect(ideas.find(({ idea }) => idea.key === "work.job-watch")?.idea.basis).toEqual([
      { kind: "task", ref: "task-1", excerpt: "Job search for a staff engineer role" },
    ]);
    // What the person mentioned ranks above what they did not.
    expect(fares?.score).toBeGreaterThanOrEqual(0.4);
    const scores = ideas.map(({ score }) => score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // Suppressed (ignored lately) and recent (tried this week) keys are left out too.
    expect(keys).not.toContain("learning.tutor");
    expect(keys).not.toContain("health-home.sleep");
    // Muted, dismissed and snoozed ones are left out.
    expect(keys.some((key) => key.startsWith("shopping."))).toBe(false);
    expect(keys).not.toContain("travel.hotels");
  });

  it("offers a cold start across sections, each a catalogue idea", async () => {
    const { ideas } = await createBuiltinIdeasProvider().generate(bareIdeasRequest(new AbortController().signal));
    expect(ideas).toHaveLength(12);
    expect(new Set(ideas.slice(0, IDEA_CATEGORIES.length).map(({ idea }) => idea.category)).size).toBe(IDEA_CATEGORIES.length);
    for (const { idea } of ideas) expect(idea.basis).toEqual([{ kind: "general", ref: idea.templateId }]);
    const scores = ideas.map(({ score }) => score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("offers only what the census has", async () => {
    const { ideas } = await createBuiltinIdeasProvider().generate(fullIdeasRequest(new AbortController().signal, ["memory"]));
    // Memory alone runs 9.1, 9.2, 10.2, 10.3, 10.4 and 16.1; the ledger rules out 9.1, 9.2 and 10.3.
    expect(ideas.map(({ idea }) => idea.templateId).sort()).toEqual(["10.2", "10.4", "16.1"]);
  });

  it("has the fast model reword the ideas that fit the person, keeping what each does and rests on", async () => {
    const sent: string[] = [];
    const host: NonNullable<IdeasGenerateRequest["host"]> = {
      runTurn: async ({ system, user }) => {
        if (system !== REWORD_SYSTEM) return { text: "{}" };
        sent.push(user);
        return {
          text:
            "Here you go:\n```json\n" +
            JSON.stringify({
              ideas: [
                {
                  key: "travel.fare-watch",
                  title: "I can watch Lisbon fares for May",
                  pitch: "Say a price and I will tell you when it drops.",
                  label: "Lisbon fares",
                  prompt: "Watch Sofia–Lisbon fares for May and tell me under €150.",
                  basis: [],
                  uses: [],
                },
                { key: "work.job-watch", title: "x".repeat(200) },
                { key: "made.up", title: "Not offered" },
              ],
            }) +
            "\n```",
        };
      },
    };
    const plain = await createBuiltinIdeasProvider().generate(fullIdeasRequest(new AbortController().signal));
    const { ideas } = await createBuiltinIdeasProvider().generate({ ...fullIdeasRequest(new AbortController().signal), host });
    expect(sent).toHaveLength(1);
    // Only ideas resting on something of the person's are sent, with the note they rest on.
    expect(JSON.parse(sent[0] ?? "{}").ideas.every((entry: { note: string }) => entry.note !== "")).toBe(true);
    const before = plain.ideas.find(({ idea }) => idea.key === "travel.fare-watch");
    const fares = ideas.find(({ idea }) => idea.key === "travel.fare-watch");
    expect(fares?.idea).toEqual({
      ...before?.idea,
      title: "I can watch Lisbon fares for May",
      pitch: "Say a price and I will tell you when it drops.",
      label: "Lisbon fares",
      prompt: "Watch Sofia–Lisbon fares for May and tell me under €150.",
    });
    // A rewording that breaks the schema keeps the catalogue's words; nothing new is added.
    expect(ideas.find(({ idea }) => idea.key === "work.job-watch")).toEqual(plain.ideas.find(({ idea }) => idea.key === "work.job-watch"));
    expect(ideas.map(({ idea }) => idea.key)).toEqual(plain.ideas.map(({ idea }) => idea.key));
  });

  it("keeps the catalogue's prompt when a rewording loses the reminders it promises", async () => {
    const request = { ...fullIdeasRequest(new AbortController().signal), brief: "I have an exam to prepare for next month." };
    const host: NonNullable<IdeasGenerateRequest["host"]> = {
      runTurn: async () => ({
        text: JSON.stringify({
          ideas: [
            {
              key: "learning.exam-prep",
              title: "I can get you ready for your exam",
              prompt: "Help me prepare for my exam: quiz me to find my weak areas, then plan my study sessions.",
            },
          ],
        }),
      }),
    };
    const plain = await createBuiltinIdeasProvider().generate(request);
    const { ideas } = await createBuiltinIdeasProvider().generate({ ...request, host });
    const exam = ideas.find(({ idea }) => idea.key === "learning.exam-prep");
    expect(exam?.idea.title).toBe("I can get you ready for your exam");
    expect(exam?.idea.prompt).toBe(plain.ideas.find(({ idea }) => idea.key === "learning.exam-prep")?.idea.prompt);
  });

  it("keeps the catalogue's words when a rewording takes up the task of an idea already tried", async () => {
    const base = fullIdeasRequest(new AbortController().signal);
    const request = {
      ...base,
      tasks: [{ taskId: "task-7", title: "Cluster the comments", summary: "Summarise the article thread" }],
      ledger: { ...base.ledger!, recentKeys: ["work.comment-clusters"] },
    };
    const host: NonNullable<IdeasGenerateRequest["host"]> = {
      runTurn: async () => ({
        text: JSON.stringify({
          ideas: [
            {
              key: "productivity.distil",
              title: "I can group thread comments by theme",
              label: "Group thread comments",
              prompt: "Group these thread comments by theme and summarise the arguments under each: [link or file]",
            },
          ],
        }),
      }),
    };
    const plain = await createBuiltinIdeasProvider().generate(request);
    const { ideas } = await createBuiltinIdeasProvider().generate({ ...request, host });
    expect(ideas.map(({ idea }) => idea.key)).not.toContain("work.comment-clusters");
    const distil = ideas.find(({ idea }) => idea.key === "productivity.distil");
    expect(distil?.idea.basis).toEqual([{ kind: "task", ref: "task-7", excerpt: "Cluster the comments" }]);
    expect(distil?.idea).toEqual(plain.ideas.find(({ idea }) => idea.key === "productivity.distil")?.idea);
  });

  it("rewords no idea matched only by more like this: it cites nothing of the person's, so it keeps the catalogue's words", async () => {
    const sent: string[] = [];
    const host: NonNullable<IdeasGenerateRequest["host"]> = {
      runTurn: async ({ system, user }) => (
        system === REWORD_SYSTEM && sent.push(user),
        { text: JSON.stringify({ ideas: [{ key: "learning.language", title: "I can teach you Portuguese for your Lisbon trip" }] }) }
      ),
    };
    const base = fullIdeasRequest(new AbortController().signal);
    const request = { ...base, ledger: { ...base.ledger!, snoozedKeys: [], boostedKeys: ["learning.language"] }, host };
    const boosted = (await createBuiltinIdeasProvider().generate(request)).ideas.find(({ idea }) => idea.key === "learning.language");
    expect(boosted?.idea.basis).toEqual([{ kind: "general", ref: expect.any(String) }]);
    expect(sent.every((user) => !user.includes("learning.language"))).toBe(true);
    expect(boosted?.idea.title).not.toContain("Lisbon");
  });

  it("writes without the model when its turn is refused or answers nonsense", async () => {
    const plain = await createBuiltinIdeasProvider().generate(fullIdeasRequest(new AbortController().signal));
    for (const runTurn of [
      async () => {
        throw new IdeasProviderError("budget");
      },
      async () => ({ text: "no json here" }),
      async () => ({ text: '{"ideas": 3}' }),
    ]) {
      expect(await createBuiltinIdeasProvider().generate({ ...fullIdeasRequest(new AbortController().signal), host: { runTurn } })).toEqual(
        plain,
      );
    }
  });

  it("asks the fast model which ideas fit the person, beyond the trigger words, and ranks its picks first", async () => {
    const turns: { system: string; user: string }[] = [];
    const bare = bareIdeasRequest(new AbortController().signal);
    const request: IdeasGenerateRequest = {
      ...bare,
      memory: [
        { recordId: "mem-cello", revisionId: "rev-cello", kind: "fact", text: "Learning the cello; practises scales every evening" },
        { recordId: "mem-dog", revisionId: "rev-dog", kind: "lesson", text: "Biscuit the beagle needs a walk before any long call" },
      ],
      ledger: {
        dismissedKeys: ["health-home.lost-pet"],
        snoozedKeys: [],
        suppressedKeys: [],
        recentKeys: [],
        mutedCategories: [],
        excludedBasis: [],
        boostedKeys: [],
        boostedCategories: [],
        examples: [],
        active: [],
      },
      host: {
        runTurn: async ({ system, user }) => {
          turns.push({ system, user });
          if (system !== TRIAGE_SYSTEM) return { text: "{}" };
          return {
            text: JSON.stringify({
              picks: [
                { key: "learning.mix-practice", note: "n1" },
                // Not offered (dismissed), not a template, or resting on no note given: each is left out.
                { key: "health-home.lost-pet", note: "n2" },
                { key: "made.up", note: "n1" },
                { key: "health-home.pet-vaccines", note: "n9" },
                { key: "health-home.pet-diet", note: "n2" },
              ],
            }),
          };
        },
      },
    };
    const { ideas } = await createBuiltinIdeasProvider().generate(request);
    // One triage turn, given the notes as data and only the ideas that could be offered.
    const triage = turns.filter(({ system }) => system === TRIAGE_SYSTEM);
    expect(triage).toHaveLength(1);
    const asked = JSON.parse(triage[0]?.user ?? "{}") as { notes: { id: string; text: string }[]; ideas: { key: string }[] };
    expect(asked.notes).toEqual([
      { id: "n1", text: "Learning the cello; practises scales every evening" },
      { id: "n2", text: "Biscuit the beagle needs a walk before any long call" },
    ]);
    expect(asked.ideas.map(({ key }) => key)).toContain("learning.mix-practice");
    expect(asked.ideas.map(({ key }) => key)).not.toContain("health-home.lost-pet");
    // The picks come first, in the model's order, each citing the note it named.
    expect(ideas.slice(0, 2).map(({ idea }) => [idea.key, idea.basis])).toEqual([
      ["learning.mix-practice", [{ kind: "memory", ref: "mem-cello", excerpt: "Learning the cello; practises scales every evening" }]],
      ["health-home.pet-diet", [{ kind: "memory", ref: "mem-dog", excerpt: "Biscuit the beagle needs a walk before any long call" }]],
    ]);
    // A trigger word alone ("learning") still cites the note, but ranks below what the model judged close.
    const language = ideas.find(({ idea }) => idea.key === "learning.language");
    expect(language?.idea.basis[0]?.kind).toBe("memory");
    expect(language?.score).toBeLessThan(ideas[1]?.score ?? 0);
    const keys = ideas.map(({ idea }) => idea.key);
    expect(keys).not.toContain("health-home.lost-pet");
    expect(keys).not.toContain("made.up");
    expect(ideas.find(({ idea }) => idea.key === "health-home.pet-vaccines")?.idea.basis[0]?.kind ?? "general").toBe("general");
  });

  it("asks no triage turn when there is nothing of the person's to fit", async () => {
    const systems: string[] = [];
    await createBuiltinIdeasProvider().generate({
      ...bareIdeasRequest(new AbortController().signal),
      host: { runTurn: async ({ system }) => (systems.push(system), { text: "{}" }) },
    });
    expect(systems).toEqual([]);
  });

  it("leans toward the sections the person takes up, among equals", async () => {
    const bare = bareIdeasRequest(new AbortController().signal);
    const before = await createBuiltinIdeasProvider().generate(bare);
    const favoured = before.ideas.at(-1)?.idea.category;
    if (favoured === undefined) throw new Error("no ideas");
    const ledger = {
      ...(bare.ledger ?? {
        dismissedKeys: [],
        snoozedKeys: [],
        suppressedKeys: [],
        recentKeys: [],
        mutedCategories: [],
        excludedBasis: [],
        boostedKeys: [],
        boostedCategories: [],
        examples: [],
        active: [],
      }),
      categoryPriors: { [favoured]: 5 },
    };
    const { ideas } = await createBuiltinIdeasProvider().generate({ ...bare, ledger });
    expect(ideas[0]?.idea.category).toBe(favoured);
  });
});
