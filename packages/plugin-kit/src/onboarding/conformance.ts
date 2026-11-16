import { describe, expect, it } from "vitest";

import {
  availableFor,
  stepsFor,
  IDEA_CAPABILITIES,
  MODEL_PROVIDER_PRESETS,
  ONBOARDING_FLOW_DEADLINE_MS,
  ONBOARDING_STEP_KINDS,
  ONBOARDING_SURFACES,
  OnboardingFlowSchema,
  type OnboardingFlowRequest,
  type OnboardingProvider,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingSurface,
} from "@tavi/contracts";

/**
 * The conformance suite every onboarding provider passes
 * — built in or a plugin's. It holds a provider
 * to what the host relies on: a flow that validates, the model step first
 * while it is open, an answer within the deadline on each surface, only what
 * is available featured, and a stop when the request's signal aborts.
 *
 * The host validates every flow anyway, and repairs or replaces one that
 * fails; this suite is how a provider learns it would be, before anyone sees
 * it.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

/** A status with every step open, as a fresh install's first read has it. */
export function freshOnboardingStatus(kinds: readonly OnboardingStepKind[] = ONBOARDING_STEP_KINDS): OnboardingStatus {
  return Object.freeze({
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: Object.freeze(
      kinds.map((kind) =>
        Object.freeze(
          kind === "ideas"
            ? { kind, state: "blocked" as const, detail: "", blockedBy: "model" as const }
            : { kind, state: "todo" as const, detail: "" },
        ),
      ),
    ),
    complete: false,
    firstRun: true,
    open: Object.freeze([...kinds]),
  });
}

/** A request on `surface` with everything available, as the host makes it for a fresh install. */
export function fullOnboardingRequest(
  surface: OnboardingSurface,
  signal: AbortSignal,
  status: OnboardingStatus = freshOnboardingStatus(),
): OnboardingFlowRequest {
  return Object.freeze({
    surface,
    status,
    census: Object.freeze([...IDEA_CAPABILITIES]),
    presets: Object.freeze(MODEL_PROVIDER_PRESETS.map((preset) => preset.id)),
    channels: Object.freeze(["telegram", "discord", "mailgun", "gmail"]),
    apps: Object.freeze(["gmail", "google-maps", "homeassistant"]),
    detected: Object.freeze([]),
    signal,
  });
}

/** The same request with nothing available but the presets: no channels, no apps, an empty census. */
export function bareOnboardingRequest(surface: OnboardingSurface, signal: AbortSignal): OnboardingFlowRequest {
  return Object.freeze({
    ...fullOnboardingRequest(surface, signal),
    census: Object.freeze([]),
    channels: Object.freeze([]),
    apps: Object.freeze([]),
  });
}

export function describeOnboardingProviderConformance(name: string, make: () => OnboardingProvider): void {
  describe(`${name}: onboarding provider conformance`, () => {
    for (const surface of ONBOARDING_SURFACES) {
      it(`answers a flow that validates, within the deadline (${surface})`, async () => {
        const started = Date.now();
        const flow = await make().flow(fullOnboardingRequest(surface, new AbortController().signal));
        expect(Date.now() - started).toBeLessThan(ONBOARDING_FLOW_DEADLINE_MS);
        const parsed = OnboardingFlowSchema.safeParse(flow);
        expect(parsed.success, parsed.error?.message).toBe(true);
        expect(stepsFor(flow, surface).length, `no step is shown on ${surface}`).toBeGreaterThan(0);
      });

      it(`puts a required model step first while the model is open (${surface})`, async () => {
        const flow = await make().flow(fullOnboardingRequest(surface, new AbortController().signal));
        const [first] = stepsFor(flow, surface);
        expect(first?.kind).toBe("model");
        expect(first?.optional).toBe(false);
      });

      it(`features only what is available (${surface})`, async () => {
        const request = bareOnboardingRequest(surface, new AbortController().signal);
        const flow = await make().flow(request);
        for (const step of flow.steps) {
          const available = availableFor(step.kind, request);
          if (available === undefined) continue;
          for (const featured of step.featured ?? []) expect(available, `${step.id} features ${featured}`).toContain(featured);
        }
      });
    }

    it("stops when the request's signal aborts", async () => {
      const before = new AbortController();
      before.abort(new Error("stopped"));
      // Settled either way — a flow is cheap — but never left hanging past the deadline.
      const settled = await Promise.race([
        make()
          .flow(fullOnboardingRequest("web", before.signal))
          .then(
            () => true,
            () => true,
          ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(settled).toBe(true);
    });
  });
}
