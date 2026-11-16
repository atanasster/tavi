import { describe, expect, it } from "vitest";

import {
  IDEA_CAPABILITIES,
  IDEA_MAX_ACTIVE,
  IdeaDraftSchema,
  IdeasProviderError,
  type IdeaCapability,
  type IdeasGenerateRequest,
  type IdeasProvider,
} from "@tavi/contracts";

/**
 * The conformance suite every ideas provider passes (docs/IDEAS-PLUGINS.md) —
 * built in or a plugin's. It holds a provider to what the host relies on:
 * answers within the contract's bounds, no capability the census left out, a
 * basis only from what it was given, the ledger respected, a stop when the
 * request's signal aborts, a sensible answer with every receive withheld or
 * every model turn refused, and its own secrets kept out of its errors.
 *
 * The host validates every answer anyway and drops what fails; this suite is
 * how a provider learns it would be dropped before anyone sees it.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

const AT = "2026-10-19T09:00:00.000Z";

export interface IdeasConformanceOptions {
  /** Secrets the provider holds (keys, tokens): none may appear in its errors. */
  readonly secrets?: readonly string[];
}

/** A request with every receive given, as the built-in provider receives it. */
export function fullIdeasRequest(signal: AbortSignal, capabilities: readonly IdeaCapability[] = IDEA_CAPABILITIES): IdeasGenerateRequest {
  return Object.freeze({
    workspaceId: "default",
    now: AT,
    timezone: "UTC",
    capabilities: Object.freeze([...capabilities]),
    memory: Object.freeze([
      Object.freeze({
        recordId: "mem-1",
        revisionId: "rev-1",
        kind: "fact" as const,
        text: "Planning a trip to Lisbon in May; wants cheap flights",
      }),
      Object.freeze({
        recordId: "mem-2",
        revisionId: "rev-2",
        kind: "preference" as const,
        text: "garden: growing tomatoes on the balcony",
      }),
    ]),
    tasks: Object.freeze([
      Object.freeze({ taskId: "task-1", title: "Job search for a staff engineer role", summary: "Compared three job offers" }),
    ]),
    brief: "More about the garden and cooking; nothing about money.",
    ledger: Object.freeze({
      dismissedKeys: Object.freeze(["travel.hotels"]),
      snoozedKeys: Object.freeze(["learning.language"]),
      suppressedKeys: Object.freeze(["learning.tutor"]),
      recentKeys: Object.freeze(["health-home.sleep"]),
      mutedCategories: Object.freeze(["shopping" as const]),
      excludedBasis: Object.freeze(["mem-9"]),
      boostedKeys: Object.freeze([]),
      boostedCategories: Object.freeze([]),
      examples: Object.freeze([]),
      active: Object.freeze([]),
    }),
    limits: Object.freeze({ maxIdeas: IDEA_MAX_ACTIVE, deadlineMs: 5_000 }),
    signal,
  });
}

/** The same request with nothing but the census, the time and the limits. */
export function bareIdeasRequest(signal: AbortSignal, capabilities: readonly IdeaCapability[] = IDEA_CAPABILITIES): IdeasGenerateRequest {
  const { memory: _memory, tasks: _tasks, brief: _brief, ledger: _ledger, ...bare } = fullIdeasRequest(signal, capabilities);
  return Object.freeze(bare);
}

export function describeIdeasProviderConformance(name: string, make: () => IdeasProvider, options: IdeasConformanceOptions = {}): void {
  describe(`${name}: ideas provider conformance`, () => {
    it("answers ideas within the contract's bounds", async () => {
      const request = fullIdeasRequest(new AbortController().signal);
      const { ideas } = await make().generate(request);
      expect(ideas.length).toBeLessThanOrEqual(request.limits.maxIdeas);
      for (const { idea, score } of ideas) {
        const parsed = IdeaDraftSchema.safeParse(idea);
        expect(parsed.success, `${String((idea as { key?: unknown }).key)}: ${parsed.error?.message ?? ""}`).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
      expect(new Set(ideas.map(({ idea }) => idea.key)).size).toBe(ideas.length);
    });

    it("uses only what the census offers", async () => {
      const capabilities: readonly IdeaCapability[] = ["web", "memory", "reminders"];
      const { ideas } = await make().generate(fullIdeasRequest(new AbortController().signal, capabilities));
      for (const { idea } of ideas) for (const use of idea.uses) expect(capabilities).toContain(use.capability);
    });

    it("cites only what it was given, never an excluded basis", async () => {
      const request = fullIdeasRequest(new AbortController().signal);
      const given = new Set([
        ...(request.memory ?? []).map((record) => record.recordId),
        ...(request.tasks ?? []).map((task) => task.taskId),
        "brief",
      ]);
      const { ideas } = await make().generate(request);
      for (const { idea } of ideas) {
        for (const basis of idea.basis) {
          if (basis.kind !== "general") expect(given.has(basis.ref), `${idea.key} cites ${basis.ref}`).toBe(true);
          expect(request.ledger?.excludedBasis).not.toContain(basis.ref);
        }
      }
      const bare = await make().generate(bareIdeasRequest(new AbortController().signal));
      for (const { idea } of bare.ideas)
        for (const basis of idea.basis) expect(basis.kind, `${idea.key} cites a ${basis.kind} it was not given`).toBe("general");
    });

    it("leaves out what the ledger rules out", async () => {
      const request = fullIdeasRequest(new AbortController().signal);
      const { ideas } = await make().generate(request);
      for (const { idea } of ideas) {
        expect(request.ledger?.dismissedKeys).not.toContain(idea.key);
        expect(request.ledger?.snoozedKeys).not.toContain(idea.key);
        expect(request.ledger?.suppressedKeys).not.toContain(idea.key);
        expect(request.ledger?.recentKeys).not.toContain(idea.key);
        expect(request.ledger?.mutedCategories).not.toContain(idea.category);
      }
    });

    it("answers with every receive withheld", async () => {
      const { ideas } = await make().generate(bareIdeasRequest(new AbortController().signal));
      expect(Array.isArray(ideas)).toBe(true);
    });

    it("answers when the host refuses its model turn, or answers it with nonsense", async () => {
      // A provider that declares `usesTurns` falls back when the day's budget is spent;
      // one that does not ignores `host` altogether. Either way the answer stays in bounds.
      const refusing = {
        runTurn: async () => {
          throw new IdeasProviderError("budget");
        },
      };
      const babbling = { runTurn: async () => ({ text: "not json { at all" }) };
      for (const host of [refusing, babbling]) {
        const request = Object.freeze({ ...fullIdeasRequest(new AbortController().signal), host });
        const { ideas } = await make().generate(request);
        expect(ideas.length).toBeLessThanOrEqual(request.limits.maxIdeas);
        for (const { idea } of ideas) expect(IdeaDraftSchema.safeParse(idea).success).toBe(true);
      }
    });

    it("stops when the request's signal aborts, before or during a generation", async () => {
      const before = new AbortController();
      before.abort(new Error("stopped"));
      await expect(make().generate(fullIdeasRequest(before.signal))).rejects.toBeDefined();
      // Aborted mid-way, it settles — answering or refusing — well within its deadline.
      const during = new AbortController();
      const pending = make().generate(fullIdeasRequest(during.signal));
      during.abort(new Error("stopped"));
      const settled = await Promise.race([
        pending.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(settled).toBe(true);
    });

    it("keeps its secrets out of its errors", async () => {
      const controller = new AbortController();
      controller.abort(new Error("stopped"));
      const error: unknown = await make()
        .generate(fullIdeasRequest(controller.signal))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error, "an aborted generation refuses").toBeDefined();
      const text = `${String(error)} ${error instanceof Error ? (error.stack ?? "") : ""}`;
      for (const secret of options.secrets ?? []) expect(text).not.toContain(secret);
    });
  });
}
