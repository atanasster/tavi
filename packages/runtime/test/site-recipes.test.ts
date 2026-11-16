import { SITE_RECIPES_MAX, SITE_RECIPE_MAX_STEPS } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { join } from "node:path";
import Database from "better-sqlite3";

import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function recipes() {
  const artifactsDirectory = directories.create("tavi-recipes-");
  return new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory }).asPort().repositories.siteRecipes;
}

describe("site recipes", () => {
  it("reads a recipe kept before replay was recorded as not replaying, and marks it", () => {
    const databasePath = join(directories.create("tavi-recipes-upgrade-"), "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(pre, MIGRATIONS.slice(0, 6));
      pre
        .prepare("INSERT INTO tavi_site_recipes (workspace_id, host, steps_json, results, uses, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("w1", "shop.example", "[]", 1, 1, "2026-10-08T10:00:00.000Z");
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: directories.create("tavi-recipes-artifacts-") });
    try {
      const repository = store.asPort().repositories.siteRecipes;
      expect(repository.get("w1", "shop.example")).not.toHaveProperty("replay");
      expect(repository.setReplay("w1", "shop.example", true)).toBe(1);
      expect(repository.get("w1", "shop.example")).toMatchObject({ replay: true });
    } finally {
      store.close();
    }
  });

  it("keeps a site's replay mark across a new recipe, and changes nothing for a site with none", () => {
    const repository = recipes();
    const steps = [{ kind: "click", role: "button", label: "Dismiss promo" }];
    repository.put({ workspaceId: "w1", host: "shop.example", steps, results: 2, updatedAt: "2026-10-08T10:00:00.000Z" });
    expect(repository.get("w1", "shop.example")).not.toHaveProperty("replay");
    expect(repository.setReplay("w1", "shop.example", true)).toBe(1);
    repository.put({ workspaceId: "w1", host: "shop.example", steps, results: 3, updatedAt: "2026-10-08T11:00:00.000Z" });
    expect(repository.get("w1", "shop.example")).toMatchObject({ replay: true, uses: 2 });
    expect(repository.setReplay("w1", "shop.example", false)).toBe(1);
    expect(repository.get("w1", "shop.example")).not.toHaveProperty("replay");
    expect(repository.setReplay("w1", "nowhere.example", true)).toBe(0);
  });

  it("keeps one recipe per site and workspace, counting the times it was kept", () => {
    const repository = recipes();
    const steps = [
      { kind: "type", role: "combobox", label: "Where from?" },
      { kind: "click", role: "option" },
    ];
    expect(
      repository.put({ workspaceId: "w1", host: "google.com", steps, results: 9, updatedAt: "2026-10-08T10:00:00.000Z" }),
    ).toMatchObject({ uses: 1, results: 9, steps });
    expect(
      repository.put({
        workspaceId: "w1",
        host: "google.com",
        steps: steps.slice(0, 1),
        results: 4,
        updatedAt: "2026-10-08T11:00:00.000Z",
      }),
    ).toMatchObject({ uses: 2, results: 4, steps: steps.slice(0, 1) });
    repository.put({ workspaceId: "w1", host: "booking.com", steps, results: 3, updatedAt: "2026-10-08T12:00:00.000Z" });
    repository.put({ workspaceId: "w2", host: "google.com", steps, results: 1, updatedAt: "2026-10-08T12:00:00.000Z" });
    expect(repository.list("w1").map((recipe) => recipe.host)).toEqual(["booking.com", "google.com"]);
    expect(repository.get("w2", "booking.com")).toBeUndefined();
    expect(repository.remove("w1", "google.com")).toBe(1);
    expect(repository.remove("w1")).toBe(1);
    expect(repository.list("w1")).toEqual([]);
    expect(repository.list("w2")).toHaveLength(1);
  });

  it("keeps only a recipe's last steps", () => {
    const repository = recipes();
    const steps = Array.from({ length: SITE_RECIPE_MAX_STEPS + 3 }, (_, index) => ({ kind: "click", label: `Step ${index}` }));
    const kept = repository.put({ workspaceId: "w1", host: "example.com", steps, results: 1, updatedAt: "t" });
    expect(kept.steps).toHaveLength(SITE_RECIPE_MAX_STEPS);
    expect(kept.steps[0]?.label).toBe("Step 3");
  });

  it("keeps at most so many sites a workspace, forgetting the one used longest ago", () => {
    const repository = recipes();
    const at = (index: number) => new Date(Date.UTC(2026, 9, 8) + index * 1_000).toISOString();
    for (let index = 0; index <= SITE_RECIPES_MAX; index += 1)
      repository.put({ workspaceId: "w1", host: `site-${index}.example`, steps: [{ kind: "click" }], results: 1, updatedAt: at(index) });
    const kept = repository.list("w1");
    expect(kept).toHaveLength(SITE_RECIPES_MAX);
    expect(repository.get("w1", "site-0.example")).toBeUndefined();
    expect(kept[0]?.host).toBe(`site-${SITE_RECIPES_MAX}.example`);
  });
});
