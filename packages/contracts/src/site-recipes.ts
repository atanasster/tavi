import type { AsyncRepository } from "./persistence-types.js";

/**
 * Site recipes: the browser steps that
 * last led to results on a site, kept per workspace, so the next task on that
 * site starts from what worked — workflow memory, after Agent Workflow Memory
 * and SkillWeaver. A step names its element by role and label, never a ref (a
 * ref is one session's), and never what was typed: a recipe says "type into
 * Where from?, pick a suggestion", and the task fills in its own values.
 *
 * A recipe is a hint shown with the site, never replayed by itself: every step
 * still goes through `browser.act` and its approvals.
 */

/** The most steps a recipe keeps: the last ones before the results. */
export const SITE_RECIPE_MAX_STEPS = 12;

/** The most sites a workspace keeps a recipe for: past it, the one used longest ago is forgotten. */
export const SITE_RECIPES_MAX = 500;

export interface SiteRecipeStep {
  readonly kind: string;
  /** The element's role and label as the observation listed it; absent for a page action (a scroll, a key). */
  readonly role?: string;
  readonly label?: string;
  /** What was chosen, for a choice that is the site's not the person's (a key, a select's option); never typed text. */
  readonly value?: string;
}

export interface SiteRecipe {
  readonly workspaceId: string;
  /** The site, as its host without `www.`. */
  readonly host: string;
  readonly steps: readonly SiteRecipeStep[];
  /** How many results the extraction that ended it found. */
  readonly results: number;
  /** How many times it has led to results. */
  readonly uses: number;
  readonly updatedAt: string;
  /** Opt-in: when true, the next session on this site replays the recipe's steps before handing the page to the model. */
  readonly replay?: boolean;
}

interface SiteRecipeRepositoryPortDefinition {
  /** Keep `steps` as the site's recipe, replacing the last; `uses` counts how often a recipe was kept for it. */
  put(input: {
    readonly workspaceId: string;
    readonly host: string;
    readonly steps: readonly SiteRecipeStep[];
    readonly results: number;
    readonly updatedAt: string;
  }): SiteRecipe;
  get(workspaceId: string, host: string): SiteRecipe | undefined;
  list(workspaceId: string): readonly SiteRecipe[];
  /** Mark one site's recipe to replay, or not: how many recipes it changed (0 when the site has none). */
  setReplay(workspaceId: string, host: string, replay: boolean): number;
  /** Forget one site's recipe, or every one; how many were forgotten. */
  remove(workspaceId: string, host?: string): number;
}

export type SiteRecipeRepositoryPort = AsyncRepository<SiteRecipeRepositoryPortDefinition>;
