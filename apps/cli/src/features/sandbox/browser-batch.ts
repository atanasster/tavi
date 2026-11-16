import { BROWSER_PAGE_MOVED, type BrowserActionOutcome, TaviError, dispatchBrowserAction } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";

import { BROWSER_BATCH_FILL_STEPS, BROWSER_BATCH_MAX_STEPS, assessBrowserBatch, longBatchRefusal } from "../approvals/call-assessors.js";
import {
  type BrowserToolContext,
  elementOf,
  hostsOfCall,
  noteDialogs,
  onPageHost,
  pageOf,
  requireChatSession,
  urlNow,
  withCancelOnAbort,
} from "./browser-context.js";
import {
  guardOf,
  noteBlock,
  noteFinalStep,
  requireDecidedHost,
  requirePageAllows,
  requireReachedAllows,
  requireSearchOnly,
  requireStageAllows,
} from "./browser-guards.js";
import { withBlockHints, withPageLabel } from "./browser-results.js";
import { BrowserBatchInputSchema } from "./browser-schemas.js";
import { withSite } from "./browser-site.js";

/** `browser.batch`: several `browser.act` steps in one call. */
export function registerBrowserBatch(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.batch",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description:
      `Run up to ${BROWSER_BATCH_FILL_STEPS} browser.act steps in one call, in order — fill a form's fields, pick a date, scroll and wait — each as browser.act would; up to ${BROWSER_BATCH_MAX_STEPS} when every step only fills the form (type, select, or a click on a checkbox or radio). ` +
      "It stops at the first step that fails or is rejected, that moves the page (a new URL, or a step that answers a fresh `page`), or that opens or closes a list or dialog: the steps after it would name elements that may be gone or moved, so observe (or use the `page` returned) and go on. " +
      "A submit, upload, download, or Enter outside a search box or suggesting field goes alone, through browser.act.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserBatchInputSchema,
    assess: (input) =>
      onPageHost(
        ctx,
        assessBrowserBatch(
          input,
          (sessionId, ref) => elementOf(ctx, sessionId, ref),
          (sessionId) => pageOf(ctx, sessionId),
        ),
        input,
      ),
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    handler: async ({ input, context, signal, callId, executionPolicy, assessedHosts }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.batch was cancelled");
      const parsed = BrowserBatchInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.batch received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      await requireDecidedHost(ctx, parsed.data.sessionId, assessedHosts, hostsOfCall(ctx, parsed.data.sessionId, parsed.data));
      await requirePageAllows(ctx, parsed.data.sessionId, context.runId, "act");
      for (const step of parsed.data.actions) await requireSearchOnly(ctx, parsed.data.sessionId, step.kind, step.ref);
      const tooLong = longBatchRefusal(parsed.data.actions, (ref) => elementOf(ctx, parsed.data.sessionId, ref));
      if (tooLong !== undefined) throw new TaviError("INVALID_INPUT", `browser.batch refused: ${tooLong}`);
      await requireStageAllows(
        ctx,
        parsed.data.sessionId,
        context.workspaceId,
        parsed.data.actions.map((step) => step.kind),
      );
      const before = await urlNow(ctx, parsed.data.sessionId);
      const steps: unknown[] = [];
      let stopped: string | undefined;
      for (const [index, step] of parsed.data.actions.entries()) {
        if (signal.aborted) {
          stopped = "cancelled";
          break;
        }
        let outcome: BrowserActionOutcome;
        try {
          outcome = await withCancelOnAbort(ctx, parsed.data.sessionId, signal, async () =>
            dispatchBrowserAction(ctx.browser, {
              sessionId: parsed.data.sessionId,
              ...(step.ref === undefined ? {} : { ref: step.ref }),
              ...(step.epoch === undefined ? {} : { epoch: step.epoch }),
              kind: step.kind,
              ...definedOnly({
                value: step.value,
                toRef: step.toRef,
                dx: step.dx,
                dy: step.dy,
                tab: step.tab,
                mode: step.mode,
                clear: step.clear,
                timeoutMs: step.timeoutMs,
                callId,
              }),
              // Each step's own guard: a batch never commits (its card refuses one), and the final step is checked again.
              guard: await guardOf(ctx, parsed.data.sessionId, false, assessedHosts),
            }),
          );
        } catch (error) {
          if (signal.aborted || (error instanceof TaviError && error.code === "CANCELLED")) {
            stopped = "cancelled";
            break;
          }
          await noteFinalStep(ctx, error, parsed.data.sessionId, context.workspaceId);
          if (step.optional === true && !(error instanceof TaviError && error.code === "NOT_AUTHORIZED")) {
            steps.push({
              kind: step.kind,
              ...(step.ref === undefined ? {} : { ref: step.ref }),
              skipped: true,
              detail: errorMessage(error),
            });
            continue;
          }
          steps.push({ kind: step.kind, error: errorMessage(error) });
          stopped = `step ${index + 1} failed`;
          break;
        }
        if (step.optional === true && outcome.status !== "accepted") {
          steps.push({
            kind: step.kind,
            ...(step.ref === undefined ? {} : { ref: step.ref }),
            skipped: true,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          });
          continue;
        }
        noteDialogs(ctx, parsed.data.sessionId, outcome);
        if (outcome.status === "accepted")
          ctx.options.recipes?.acted(parsed.data.sessionId, { kind: step.kind, ref: step.ref, value: step.value });
        steps.push(
          await withSite(
            ctx,
            withBlockHints(await noteBlock(ctx, { kind: step.kind, ...outcome }, context.runId), ctx.handoff),
            context.workspaceId,
          ),
        );
        const last = index === parsed.data.actions.length - 1;
        if (outcome.status !== "accepted") {
          stopped = `step ${index + 1} was ${outcome.status}`;
        } else if (!last && outcome.changes?.some((line) => line.startsWith("appeared: ") || line.startsWith("closed: ")) === true) {
          // A list or dialog that opened or closed moved the elements after it: the next step's ref may name another.
          stopped = `step ${index + 1} opened or closed part of the page`;
        } else if (
          !last &&
          // A select sends the page back where it was, its refs still good; any other step that answers a page moved it
          // (a reload of the same address, a view swapped in place).
          ((outcome.page !== undefined && (step.kind !== "select" || outcome.page.url !== before)) ||
            outcome.changes?.some((line) => line.startsWith(BROWSER_PAGE_MOVED)) === true ||
            outcome.detail?.includes(BROWSER_PAGE_MOVED) === true)
        ) {
          stopped = `step ${index + 1} moved the page`;
        }
        if (stopped !== undefined) break;
      }
      const skipped = parsed.data.actions.length - steps.length;
      await requireReachedAllows(ctx, parsed.data.sessionId, before, context, executionPolicy?.mode === "unattended", signal);
      // Where the steps left the page: the next call there is held to that host.
      await urlNow(ctx, parsed.data.sessionId);
      return withPageLabel(
        { steps, ...(stopped === undefined ? {} : { stopped, ...(skipped === 0 ? {} : { skipped }) }) },
        pageOf(ctx, parsed.data.sessionId),
      );
    },
  });
}
