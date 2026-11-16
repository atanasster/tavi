import type { BrowserObservation, SiteRecipe, SiteRecipeRepositoryPort, SiteRecipeStep } from "@tavi/contracts";
import { describe, expect, it } from "vitest";
import { partialFake } from "@tavi/test-support";

import {
  createRecipeRecorder,
  matchRecipeStepElement,
  recipeView,
  replaySiteRecipe,
  siteOf,
} from "../../src/features/browser/site-recipes.js";

function memoryRecipes(): SiteRecipeRepositoryPort & { readonly kept: SiteRecipe[] } {
  const kept: SiteRecipe[] = [];
  return partialFake<SiteRecipeRepositoryPort & { readonly kept: SiteRecipe[] }>({
    kept,
    put: async (input: { workspaceId: string; host: string; steps: readonly SiteRecipeStep[]; results: number; updatedAt: string }) => {
      const recipe = { ...input, uses: kept.filter((entry) => entry.host === input.host).length + 1 };
      kept.push(recipe);
      return recipe;
    },
    get: async (workspaceId: string, host: string) =>
      kept.filter((entry) => entry.workspaceId === workspaceId && entry.host === host).at(-1),
    list: async () => kept,
    setReplay: async (workspaceId: string, host: string, replay: boolean) => {
      const found = kept.filter((entry) => entry.workspaceId === workspaceId && entry.host === host);
      for (const entry of found) Object.assign(entry, { replay: replay || undefined });
      return found.length;
    },
    remove: async () => 0,
  });
}

describe("the recipe recorder", () => {
  it("keeps a site's steps by role and label once an extraction there finds results, and never typed text", async () => {
    const repository = memoryRecipes();
    const recorder = createRecipeRecorder(repository, () => "2026-10-08T12:00:00.000Z");
    recorder.observed("s1", { url: "https://other.example/", elements: [{ ref: "el-1", role: "link", text: "Go" }] });
    recorder.acted("s1", { kind: "click", ref: "el-1" });
    recorder.observed("s1", {
      url: "https://www.google.com/travel/flights",
      elements: [
        { ref: "el-4", role: "combobox", text: "Where from?" },
        { ref: "el-9", role: "combobox", text: "Cabin" },
      ],
    });
    recorder.acted("s1", { kind: "type", ref: "el-4", value: "Sofia" });
    // A part of the page observed adds to what is known of it: el-4 and el-9 keep their names.
    recorder.observed("s1", {
      url: "https://www.google.com/travel/flights",
      elements: [
        { ref: "el-12", role: "option", text: "Sofia, Bulgaria" },
        { ref: "el-13", role: "button", text: "Search near Sofia" },
      ],
    });
    recorder.acted("s1", { kind: "click", ref: "el-12" });
    recorder.acted("s1", { kind: "click", ref: "el-13" });
    recorder.acted("s1", { kind: "select", ref: "el-9", value: "Business" });
    recorder.acted("s1", { kind: "scroll", value: "down" });
    await recorder.extracted("w1", "s1", "https://www.google.com/travel/flights?tfs=x", 7);
    expect(repository.kept).toEqual([
      {
        workspaceId: "w1",
        host: "google.com",
        results: 7,
        uses: 1,
        updatedAt: "2026-10-08T12:00:00.000Z",
        // An option is kept by role alone; a label holding what was typed is dropped; a select's choice is the person's.
        steps: [
          { kind: "type", role: "combobox", label: "Where from?" },
          { kind: "click", role: "option" },
          { kind: "click", role: "button" },
          { kind: "select", role: "combobox", label: "Cabin" },
          { kind: "scroll", value: "down" },
        ],
      },
    ]);
    expect(JSON.stringify(repository.kept)).not.toContain("Sofia");
    expect(JSON.stringify(repository.kept)).not.toContain("Business");
    // Nothing found, or nothing done there: nothing kept.
    await recorder.extracted("w1", "s1", "https://www.google.com/travel/flights", 3);
    await recorder.extracted("w1", "s2", "https://www.google.com/", 0);
    expect(repository.kept).toHaveLength(1);
    expect(await recorder.recipeFor("w1", "https://google.com/anything")).toMatchObject({ host: "google.com" });
  });

  it("keeps no label that may name the person: an email, a phone number, an account's digits", async () => {
    const repository = memoryRecipes();
    const recorder = createRecipeRecorder(repository, () => "t");
    recorder.observed("s1", {
      url: "https://shop.example/",
      elements: [
        { ref: "el-1", role: "button", text: "Continue as jane@example.com" },
        { ref: "el-2", role: "button", text: "Call +1 (555) 010-2030" },
        { ref: "el-3", role: "tab", text: "Card ending 4242" },
        { ref: "el-4", role: "button", text: "Search" },
      ],
    });
    for (const ref of ["el-1", "el-2", "el-3", "el-4"]) recorder.acted("s1", { kind: "click", ref });
    await recorder.extracted("w1", "s1", "https://shop.example/results", 2);
    expect(repository.kept[0]?.steps).toEqual([
      { kind: "click", role: "button" },
      { kind: "click", role: "button" },
      { kind: "click", role: "tab" },
      { kind: "click", role: "button", label: "Search" },
    ]);
  });

  it("names a site by its host without www, and says a recipe as steps to follow", () => {
    expect(siteOf("https://WWW.Booking.com/x")).toBe("booking.com");
    expect(siteOf("nope")).toBeUndefined();
    const view = recipeView({
      workspaceId: "w1",
      host: "google.com",
      steps: [
        { kind: "type", role: "combobox", label: "Where from?" },
        { kind: "press", value: "Enter" },
      ],
      results: 3,
      uses: 2,
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    expect(view).toEqual({
      note: expect.stringContaining("2 times, 2026-10-08"),
      steps: ['type combobox "Where from?"', "press the page (Enter)"],
    });
  });

  it("does not replay a recipe by default, and replays opt-in recipes until the first mismatch, missing value, or commit", async () => {
    const repository = memoryRecipes();
    const recorder = createRecipeRecorder(repository, () => "2026-10-08T12:00:00.000Z");
    recorder.observed("s1", {
      url: "https://shop.example/",
      elements: [
        { ref: "el-1", role: "button", text: "Dismiss promo" },
        { ref: "el-2", role: "combobox", text: "Sort by" },
        { ref: "el-3", role: "button", text: "Buy now", submitsForm: true },
      ],
    });
    recorder.acted("s1", { kind: "click", ref: "el-1" });
    recorder.acted("s1", { kind: "scroll", value: "down" });
    recorder.acted("s1", { kind: "click", ref: "el-3" });
    await recorder.extracted("w1", "s1", "https://shop.example/items", 4);

    // Default: replay is not enabled.
    const defaultRecipe = await recorder.recipeFor("w1", "https://shop.example/");
    expect(defaultRecipe?.replay).toBeUndefined();

    const page1: BrowserObservation = {
      sessionId: "s2",
      url: "https://shop.example/",
      title: "Shop",
      epoch: 1,
      elements: [
        { ref: "el-10", role: "button", text: "Dismiss promo" },
        { ref: "el-11", role: "button", text: "Buy now", submitsForm: true },
      ],
    };
    const page2: BrowserObservation = {
      ...page1,
      epoch: 2,
      elements: [{ ref: "el-20", role: "button", text: "Buy now", submitsForm: true }],
    };

    const unoptedResult = await replaySiteRecipe(defaultRecipe!, page1, async () => ({
      ok: true,
      page: page2,
    }));
    expect(unoptedResult).toEqual({
      replayedSteps: 0,
      totalSteps: 3,
      page: page1,
    });

    // Opt-in replay: runs steps by role and label, and stops before the commit control ("Buy now").
    // A person marks the site (`tavi browser recipes --replay shop.example`): the store keeps it.
    await repository.setReplay("w1", "shop.example", true);
    const optedRecipe = await recorder.recipeFor("w1", "https://shop.example/");
    expect(optedRecipe?.replay).toBe(true);

    const executed: Array<{ kind: string; ref?: string; value?: string }> = [];
    const replayed = await replaySiteRecipe(optedRecipe!, page1, async (step, matchedRef) => {
      executed.push({
        kind: step.kind,
        ...(matchedRef === undefined ? {} : { ref: matchedRef }),
        ...(step.value === undefined ? {} : { value: step.value }),
      });
      return { ok: true, page: page2 };
    });

    expect(executed).toEqual([
      { kind: "click", ref: "el-10" },
      { kind: "scroll", value: "down" },
    ]);
    expect(replayed).toEqual({
      replayedSteps: 2,
      totalSteps: 3,
      stoppedReason: "commit",
      page: page2,
    });

    // Stops at missing user value or ambiguous/mismatched element.
    expect(
      matchRecipeStepElement({ kind: "click", role: "button", label: "Dismiss promo" }, [
        { ref: "el-1", role: "button", text: "Dismiss promo" },
        { ref: "el-2", role: "button", text: "Dismiss promo" },
      ]),
    ).toEqual({ stopReason: "mismatch" });

    const missingValueOutcome = await replaySiteRecipe(
      {
        ...optedRecipe!,
        steps: [{ kind: "type", role: "combobox", label: "Sort by" }],
      },
      page1,
      async () => ({ ok: true, page: page2 }),
    );
    expect(missingValueOutcome).toEqual({
      replayedSteps: 0,
      totalSteps: 1,
      stoppedReason: "missing_value",
      page: page1,
    });
  });
});
