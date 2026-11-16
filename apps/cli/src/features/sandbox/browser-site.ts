import { type BrowserActionKind, type BrowserObservation, labelIsFinalStep, siteView, urlIsFinalStep } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import { assessBrowserAct } from "../approvals/call-assessors.js";
import { recipeView, replaySiteRecipe, siteOf, type ReplaySummary } from "../browser/site-recipes.js";
import { type BrowserToolContext, MAX_OBSERVED_SESSIONS, elementOf, hostOfPage, urlNow } from "./browser-context.js";
import {
  frameUrlAllowed,
  guardOf,
  noteBlock,
  noteFinalStep,
  requireDecidedHost,
  requirePageAllows,
  requireReachedAllows,
  requireSearchOnly,
  requireStageAllows,
} from "./browser-guards.js";
import { type RecipeReplayContext, withBlockHints } from "./browser-results.js";

/**
 * `result` (an observation, or a result carrying one as `page`) told to the
 * recipe recorder, and with the skill and the workspace's recipe of its site
 * the first time this session is there. A recipe a person marked "replay"
 * runs only for `replay`'s call (one that opened the page), in an attended run
 * whose chat holds nothing untrusted.
 */
export async function withSite<T>(
  ctx: BrowserToolContext,
  result: T,
  workspaceId: string,
  replay?: RecipeReplayContext,
  { siteNotes = true }: { readonly siteNotes?: boolean } = {},
): Promise<T> {
  if (typeof result !== "object" || result === null) return result;
  const value = result as { readonly sessionId?: unknown; readonly url?: unknown; readonly elements?: unknown; readonly page?: unknown };
  if (value.page !== undefined) return { ...result, page: await withSite(ctx, value.page, workspaceId, replay, { siteNotes }) } as T;
  if (typeof value.sessionId !== "string" || typeof value.url !== "string") return result;
  ctx.pageNow.set(value.sessionId, value.url);
  if (ctx.pageNow.size > MAX_OBSERVED_SESSIONS) ctx.pageNow.delete(ctx.pageNow.keys().next().value ?? "");
  ctx.options.recipes?.observed(value.sessionId, value);
  if (Array.isArray(value.elements)) {
    let known = ctx.observed.get(value.sessionId);
    if (known === undefined || known.url !== value.url) {
      known = { url: value.url, elements: new Map() };
      ctx.observed.set(value.sessionId, known);
      if (ctx.observed.size > MAX_OBSERVED_SESSIONS) ctx.observed.delete(ctx.observed.keys().next().value ?? "");
    }
    // A stage profile's final step is tagged, so the card and the model see it for what it is.
    const rule = ctx.options.sites?.finalStepRuleNow(value.url);
    // On a final step's own address, the control that submits its form is the final step too.
    const finalPage = rule !== undefined && typeof value.url === "string" && urlIsFinalStep(value.url, rule);
    const isFinalStep = (element: { readonly text?: unknown; readonly submitsForm?: unknown }): boolean =>
      rule !== undefined &&
      ((typeof element.text === "string" && labelIsFinalStep(element.text, rule)) || (finalPage && element.submitsForm === true));
    for (const element of value.elements as {
      readonly ref?: unknown;
      readonly role?: unknown;
      readonly text?: unknown;
      readonly submitsForm?: unknown;
      readonly searchForm?: unknown;
      readonly inForm?: unknown;
      readonly secret?: unknown;
      readonly frame?: unknown;
      readonly href?: unknown;
    }[]) {
      if (typeof element?.ref !== "string") continue;
      const text = typeof element.text === "string" ? element.text : undefined;
      const frame = typeof element.frame === "string" && !element.frame.endsWith(" (not allowed)") ? element.frame : undefined;
      known.elements.set(element.ref, {
        role: typeof element.role === "string" ? element.role : undefined,
        text,
        submitsForm: element.submitsForm === true,
        searchForm: element.searchForm === true,
        inForm: element.inForm === true,
        finalStep: isFinalStep(element),
        secret: element.secret === true,
        ...(frame === undefined ? {} : { frame }),
        // Where `open_in_tab` on this ref goes, asked about and opened as this observation listed it.
        ...(typeof element.href === "string" ? { href: element.href } : {}),
      });
    }
    const { sessionId, url: pageUrl } = value;
    const isFrameOriginAllowed = (frameOrigin: string): boolean =>
      !frameOrigin.endsWith(" (not allowed)") && frameUrlAllowed(ctx, frameOrigin, pageUrl, sessionId);
    const disallowedPrefixes = new Set<string>();
    const filteredElements: unknown[] = [];
    for (const element of value.elements as {
      readonly ref?: unknown;
      readonly frame?: unknown;
    }[]) {
      if (typeof element?.frame === "string" && !element.frame.endsWith(" (not allowed)") && !isFrameOriginAllowed(element.frame)) {
        const refStr = typeof element.ref === "string" ? element.ref : "";
        const prefix = refStr.includes(":") ? (refStr.split(":", 1)[0] ?? "f1") : "f1";
        if (refStr !== "") known.elements.delete(refStr);
        if (!disallowedPrefixes.has(prefix)) {
          disallowedPrefixes.add(prefix);
          const frameHost = hostOfPage(element.frame) || element.frame;
          filteredElements.push({ ref: `${prefix}:frame`, frame: `${frameHost} (not allowed)` });
        }
        continue;
      }
      filteredElements.push(element);
    }
    if (disallowedPrefixes.size > 0) {
      result = { ...result, elements: filteredElements } as T;
    }
    if (rule !== undefined) {
      const currentElements = ((result as { readonly elements?: unknown }).elements ?? value.elements) as {
        readonly text?: unknown;
        readonly submitsForm?: unknown;
      }[];
      const tagged = currentElements.map((element) => (isFinalStep(element) ? { ...element, finalStep: true } : element));
      result = { ...result, elements: tagged } as T;
      // Reaching the page that holds the final step is what `stage.perDay` counts: a final control that
      // submits a form, not a same-named link or button elsewhere (a listing's "Apply" on SuccessFactors).
      if (tagged.some((element) => (element as { readonly finalStep?: unknown }).finalStep === true && element.submitsForm === true))
        await ctx.options.sites?.finalStepReached({ workspaceId, sessionId: value.sessionId, url: value.url });
    }
  }
  const site = siteOf(value.url);
  if (site === undefined || !siteNotes) return result;
  const shown = ctx.shownSites.get(value.sessionId) ?? new Set<string>();
  const skill = ctx.options.siteSkills?.skillFor(value.url);
  const skillKey = skill === undefined ? undefined : `skill:${skill.id}`;
  const recipeKey = `recipe:${site}`;
  const showSkill = skillKey !== undefined && !shown.has(skillKey);
  const recipe = shown.has(recipeKey) ? undefined : await ctx.options.recipes?.recipeFor(workspaceId, value.url);
  if (skillKey !== undefined) shown.add(skillKey);
  shown.add(recipeKey);
  ctx.shownSites.set(value.sessionId, shown);
  if (!showSkill && recipe === undefined) return result;
  let replaySummary: ReplaySummary | undefined;
  if (recipe?.replay === true && replay?.allowed === true && Array.isArray((result as { readonly elements?: unknown }).elements)) {
    const sessionId = value.sessionId;
    // The site the recipe is for: a step that finds the page moved off it is not replayed.
    const startHost = hostOfPage(value.url);
    const replayed = await replaySiteRecipe(recipe, result as unknown as BrowserObservation, async (step, matchedRef, currentPage) => {
      try {
        // Each step is held to what `browser.act` is: the site's rules for the page, the host, the stage, assist-only.
        await requirePageAllows(ctx, sessionId, replay.runId, "act");
        if (startHost !== "") await requireDecidedHost(ctx, sessionId, [startHost]);
        await requireStageAllows(ctx, sessionId, workspaceId, [step.kind]);
        await requireSearchOnly(ctx, sessionId, step.kind, matchedRef);
        // A step `browser.act` would ask about on its own (a submit, a press that sends or commits) is not replayed:
        // no one is asked here, so it is left to the model, and the person's card.
        const assessed = assessBrowserAct(
          { sessionId, kind: step.kind, ...(matchedRef === undefined ? {} : { ref: matchedRef }), ...definedOnly({ value: step.value }) },
          matchedRef === undefined
            ? undefined
            : (currentPage.elements.find((element) => element.ref === matchedRef) ?? elementOf(ctx, sessionId, matchedRef)),
          undefined,
          currentPage.url,
        );
        // A step refused outright stops it as failed, with why: it is no one's to approve.
        if (assessed.hardDeny !== undefined) return { ok: false, page: currentPage, detail: assessed.hardDeny.slice(0, 300) };
        if (assessed.scopeGroup === undefined) return { ok: false, page: currentPage, commit: true };
        const pageHost = hostOfPage(currentPage.url);
        const guard = await guardOf(ctx, sessionId, false, pageHost === "" ? undefined : [pageHost]);
        const before = await urlNow(ctx, sessionId);
        const outcome = await ctx.browser
          .act({
            sessionId,
            kind: step.kind as BrowserActionKind,
            ...(matchedRef === undefined
              ? {}
              : { ref: matchedRef, ...(currentPage.epoch === undefined ? {} : { epoch: currentPage.epoch }) }),
            ...(step.value === undefined ? {} : { value: step.value }),
            guard,
          })
          .catch(async (error: unknown) => {
            await noteFinalStep(ctx, error, sessionId, workspaceId);
            throw error;
          });
        ctx.options.recipes?.acted(sessionId, { kind: step.kind, ref: matchedRef, value: step.value });
        // And after it, as `browser.act` is: a wall it met ends the site for the task; a page Tavi may not read is not returned.
        await noteBlock(ctx, outcome, replay.runId);
        await requireReachedAllows(ctx, sessionId, before, { workspaceId, runId: replay.runId }, false, replay.signal);
        const nextObs = withBlockHints(outcome.page ?? (await ctx.browser.observe(sessionId)), ctx.handoff);
        ctx.pageNow.set(sessionId, nextObs.url);
        ctx.options.recipes?.observed(sessionId, nextObs);
        return { ok: outcome.status === "accepted", page: nextObs };
      } catch (error) {
        return { ok: false, page: currentPage, detail: errorMessage(error).slice(0, 300) };
      }
    });
    replaySummary = {
      replayedSteps: replayed.replayedSteps,
      ...(replayed.stoppedReason === undefined ? {} : { stoppedReason: replayed.stoppedReason }),
      ...(replayed.stoppedDetail === undefined ? {} : { stoppedDetail: replayed.stoppedDetail }),
    };
    if (replayed.replayedSteps > 0) {
      result = (await withSite(ctx, replayed.page, workspaceId)) as unknown as T;
    }
  }
  return {
    ...result,
    ...(showSkill && skill !== undefined ? { site: siteView(skill, ctx.handoff) } : {}),
    ...(recipe === undefined ? {} : { recipe: recipeView(recipe, replaySummary) }),
  } as T;
}
