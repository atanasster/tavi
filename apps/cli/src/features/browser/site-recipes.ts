import {
  SITE_RECIPE_MAX_STEPS,
  commitCategory,
  type BrowserElementSummary,
  type BrowserObservation,
  type SiteRecipe,
  type SiteRecipeRepositoryPort,
  type SiteRecipeStep,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

/**
 * Learning which steps work on a site.
 * The browser tools tell the recorder what each session observed and did;
 * when `browser.extract` finds results, the session's last steps on that site
 * become the workspace's recipe for it, and the next session to reach the site
 * is shown it. Nothing is replayed by itself, and what was typed is never kept.
 */

/** A site as recipes are keyed: its host, lower-cased, without `www.`. */
export function siteOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? undefined : host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** The kinds whose value is the site's, not the person's, kept in a step: a key, a scroll's direction. */
const KEPT_VALUES = new Set(["press", "scroll"]);
/**
 * The roles whose label is the site's own control — "Where from?", "Search",
 * "Departure" — and so kept. An option, a cell, a link or a list item is named
 * by what it shows, which is often the person's own data (the city they typed,
 * the date they chose, their account): kept by role alone.
 */
const LABELLED_ROLES = new Set([
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "slider",
  "spinbutton",
]);

/**
 * A label that may name the person rather than the site: an email address, a
 * phone number or any run of four or more digits (an account, a booking
 * reference, a card's last digits) — "Continue as jane@…" is never kept.
 */
const PERSONAL = /@|\d[\d\s().-]{3,}\d|\d{4,}/;

interface SessionSteps {
  /** The elements observed on the current page, by ref (a ref names one element for the session's life), to name a step's element. */
  elements: Map<string, BrowserElementSummary>;
  url: string | undefined;
  steps: { readonly site: string; readonly step: SiteRecipeStep }[];
  /** What was typed in the session: never kept, and a label that holds it is dropped. */
  typed: string[];
}

export interface RecipeRecorder {
  /** An observation of `sessionId`: its URL and elements. */
  observed(sessionId: string, observation: { readonly url?: unknown; readonly elements?: unknown }): void;
  /** An action `sessionId` ran. */
  acted(sessionId: string, action: { readonly kind: string; readonly ref?: string | undefined; readonly value?: string | undefined }): void;
  /** `browser.extract` found `results` on `url`: the session's steps there become the site's recipe. */
  extracted(workspaceId: string, sessionId: string, url: string, results: number): Promise<void>;
  /** The workspace's recipe for the site of `url`, if it has one. */
  recipeFor(workspaceId: string, url: string): Promise<SiteRecipe | undefined>;
}

/** The most sessions the recorder follows at once; the oldest is forgotten past it. */
const MAX_SESSIONS = 200;

export function createRecipeRecorder(
  repository: SiteRecipeRepositoryPort,
  now: () => string,
  onError: (error: unknown) => void = () => undefined,
): RecipeRecorder {
  const sessions = new Map<string, SessionSteps>();
  const of = (sessionId: string): SessionSteps => {
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = { elements: new Map(), url: undefined, steps: [], typed: [] };
      sessions.set(sessionId, session);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value ?? "");
    }
    return session;
  };
  return {
    observed(sessionId, observation) {
      const session = of(sessionId);
      // Another page names other elements; the same page observed again (or in part) adds to what is known of it.
      if (typeof observation.url === "string" && observation.url !== session.url) {
        session.url = observation.url;
        session.elements = new Map();
      }
      if (Array.isArray(observation.elements)) {
        for (const element of observation.elements as BrowserElementSummary[])
          if (typeof element?.ref === "string") session.elements.set(element.ref, element);
      }
    },
    acted(sessionId, action) {
      const session = of(sessionId);
      const site = session.url === undefined ? undefined : siteOf(session.url);
      if (site === undefined) return;
      const element = action.ref === undefined ? undefined : session.elements.get(action.ref);
      if (action.kind === "type" && action.value !== undefined && action.value.trim() !== "")
        session.typed.push(action.value.trim().toLowerCase());
      const label =
        element?.text !== undefined &&
        element.role !== undefined &&
        LABELLED_ROLES.has(element.role) &&
        !PERSONAL.test(element.text) &&
        !session.typed.some((typed) => element.text?.toLowerCase().includes(typed) === true)
          ? element.text
          : undefined;
      const step: SiteRecipeStep = {
        kind: action.kind,
        ...(element?.role === undefined ? {} : { role: element.role }),
        ...(label === undefined ? {} : { label }),
        ...(action.value !== undefined && KEPT_VALUES.has(action.kind) ? { value: action.value.slice(0, 80) } : {}),
      };
      session.steps.push({ site, step });
      if (session.steps.length > SITE_RECIPE_MAX_STEPS * 4) session.steps.splice(0, session.steps.length - SITE_RECIPE_MAX_STEPS * 4);
    },
    async extracted(workspaceId, sessionId, url, results) {
      const site = siteOf(url);
      if (site === undefined || results <= 0) return;
      const session = sessions.get(sessionId);
      // The steps since the session last came to this site, in order.
      const steps: SiteRecipeStep[] = [];
      for (const entry of [...(session?.steps ?? [])].reverse()) {
        if (entry.site !== site) break;
        steps.unshift(entry.step);
      }
      if (steps.length === 0) return;
      try {
        await repository.put({ workspaceId, host: site, steps, results, updatedAt: now() });
      } catch (error) {
        // A recipe is a hint: failing to keep one never fails the extraction.
        onError(error);
      }
      if (session !== undefined) session.steps = [];
    },
    async recipeFor(workspaceId, url) {
      const site = siteOf(url);
      if (site === undefined) return undefined;
      try {
        return await repository.get(workspaceId, site);
      } catch (error) {
        onError(error);
        return undefined;
      }
    },
  };
}

/**
 * Matches a recipe step's target element on the current page by role and label.
 * Stops before any commit control, final-step control, or secret field.
 */
export function matchRecipeStepElement(
  step: SiteRecipeStep,
  elements: readonly BrowserElementSummary[],
): { readonly matched?: BrowserElementSummary; readonly stopReason?: "mismatch" | "commit" } {
  const candidates = elements.filter((el) => {
    if (el.frame?.endsWith(" (not allowed)") === true) return false;
    if (step.role !== undefined && el.role !== step.role) return false;
    if (step.label !== undefined && el.text !== step.label) return false;
    return true;
  });
  if (candidates.length !== 1) return { stopReason: "mismatch" };
  const candidate = candidates[0]!;
  if (candidate.secret === true) return { stopReason: "mismatch" };
  if (
    candidate.submitsForm === true ||
    candidate.finalStep === true ||
    (candidate.searchForm !== true && commitCategory(candidate.text ?? "", candidate.submitsForm === true) !== undefined)
  ) {
    return { stopReason: "commit" };
  }
  return { matched: candidate };
}

/** What a replay did, as the recipe view tells the model: how far it got, and why it stopped. */
export interface ReplaySummary {
  readonly replayedSteps: number;
  readonly stoppedReason?: string | undefined;
  readonly stoppedDetail?: string | undefined;
}

export interface ReplaySiteRecipeResult {
  readonly replayedSteps: number;
  readonly totalSteps: number;
  readonly stoppedReason?: "mismatch" | "commit" | "missing_value" | "failed";
  /** Why the step that failed was refused or did not land, when it said. */
  readonly stoppedDetail?: string | undefined;
  readonly page: BrowserObservation;
}

/**
 * Replays an opt-in site recipe (`recipe.replay === true`) step by step with
 * batch semantics: every guard applies via `runStep`, and replay stops at the
 * first mismatch, missing user value, or commit control so the model continues
 * from the replayed page.
 */
export async function replaySiteRecipe(
  recipe: SiteRecipe,
  initialPage: BrowserObservation,
  runStep: (
    step: SiteRecipeStep,
    matchedRef: string | undefined,
    page: BrowserObservation,
  ) => Promise<{
    readonly ok: boolean;
    readonly page: BrowserObservation;
    readonly detail?: string | undefined;
    /** The step is one asked about each time (a submit, a download, an Enter that sends a form): it was not run. */
    readonly commit?: boolean | undefined;
  }>,
): Promise<ReplaySiteRecipeResult> {
  if (recipe.replay !== true) {
    return { replayedSteps: 0, totalSteps: recipe.steps.length, page: initialPage };
  }
  let currentPage = initialPage;
  let replayedSteps = 0;
  for (const step of recipe.steps) {
    // A submit sends, and an upload or a download is asked about each time: replay stops before them.
    if (step.kind === "submit" || step.kind === "upload" || step.kind === "download") {
      return { replayedSteps, totalSteps: recipe.steps.length, stoppedReason: "commit", page: currentPage };
    }
    if ((step.kind === "type" || step.kind === "select") && (step.value === undefined || step.value === "")) {
      return { replayedSteps, totalSteps: recipe.steps.length, stoppedReason: "missing_value", page: currentPage };
    }
    let matchedRef: string | undefined;
    if (step.role !== undefined || step.label !== undefined) {
      const match = matchRecipeStepElement(step, currentPage.elements);
      if (match.matched === undefined) {
        return {
          replayedSteps,
          totalSteps: recipe.steps.length,
          stoppedReason: match.stopReason ?? "mismatch",
          page: currentPage,
        };
      }
      matchedRef = match.matched.ref;
    } else if (step.kind !== "scroll" && step.kind !== "press" && step.kind !== "wait_for" && step.kind !== "back") {
      return { replayedSteps, totalSteps: recipe.steps.length, stoppedReason: "mismatch", page: currentPage };
    }
    const outcome = await runStep(step, matchedRef, currentPage);
    currentPage = outcome.page;
    if (outcome.commit === true) {
      return { replayedSteps, totalSteps: recipe.steps.length, stoppedReason: "commit", page: currentPage };
    }
    if (!outcome.ok) {
      return {
        replayedSteps,
        totalSteps: recipe.steps.length,
        stoppedReason: "failed",
        ...(outcome.detail === undefined ? {} : { stoppedDetail: outcome.detail }),
        page: currentPage,
      };
    }
    replayedSteps += 1;
  }
  return { replayedSteps, totalSteps: recipe.steps.length, page: currentPage };
}

/** One step in words a model follows: `click button "Search"`, `press the page (Enter)`. */
export function describeRecipeStep(step: { readonly [key in keyof SiteRecipeStep]: SiteRecipeStep[key] | undefined }): string {
  return [
    step.kind,
    step.role === undefined && step.label === undefined ? "the page" : `${step.role ?? "element"} ${JSON.stringify(step.label ?? "")}`,
    step.value === undefined ? "" : `(${step.value})`,
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** A recipe as an observation carries it: what worked, in words a model follows. */
export function recipeView(recipe: SiteRecipe, replaySummary?: ReplaySummary): Readonly<Record<string, unknown>> {
  return {
    note: `These steps last led to results on this site (${plural(recipe.uses, "time")}, ${recipe.updatedAt.slice(0, 10)}); follow them with this task's own values where they still fit the page.`,
    steps: recipe.steps.map(describeRecipeStep),
    ...(replaySummary === undefined
      ? {}
      : {
          replayedSteps: replaySummary.replayedSteps,
          ...(replaySummary.stoppedReason === undefined ? {} : { stoppedReason: replaySummary.stoppedReason }),
          ...(replaySummary.stoppedDetail === undefined ? {} : { stoppedDetail: replaySummary.stoppedDetail }),
        }),
  };
}
