import {
  TaviError,
  RouterSettingsSchema,
  type RouterPort,
  type RouterDecisionInput,
  type RouterReceipt,
  type MemorySearchHit,
  type ContextProjectionSnapshot,
  type ActiveSkill,
  type AgentMailboxEnvelopeRecord,
  type AgentMailboxRepositoryPort,
  type MemoryActor,
  type MemoryRecord,
  type MemoryServicePort,
  type SkillManifest,
  type SkillRolloutRepositoryPort,
  type SkillServicePort,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { SKILL_DESCRIPTION_MAX_CHARS, SKILL_LISTING_MAX } from "../src/context/skill-listing.js";

import {
  assembleContext,
  assembleRoutedContext,
  collectContextRoutingCandidates,
  defaultEstimateTokens,
  MEMORY_UNAVAILABLE_LINE,
  PREFERENCE_CONFLICT_NOTE,
  prepareContextAdvice,
} from "@tavi/agent-host/context";

/**
 * Context assembly.
 *
 * A fixture `MemoryServicePort` keeps this test decoupled from `@tavi/runtime`
 * (plugins must not import runtime implementation), the same way
 * `workflow.test.ts` uses fixture ports rather than the real adapters.
 */

const actor: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };

/** A real `MemoryRecord` shape, so a fixture stays honest and type-checked against the port. */
function fixtureRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    recordId: "rec1",
    kind: "preference",
    scope: { kind: "personal", principalId: "alice" },
    scopeKey: "personal|p=alice",
    status: "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureMemory(overrides: Partial<MemoryServicePort> = {}): MemoryServicePort {
  const notImplemented = (): never => {
    throw new Error("not implemented");
  };
  return {
    // The port's reads for the operator's page and counts: not this fixture's.
    operatorView: notImplemented,
    history: notImplemented,
    related: notImplemented,
    counts: notImplemented,
    principals: notImplemented,
    eligible: notImplemented,
    propose: () => {
      throw new Error("not implemented");
    },
    approve: () => {
      throw new Error("not implemented");
    },
    reject: () => {
      throw new Error("not implemented");
    },
    correct: () => {
      throw new Error("not implemented");
    },
    revoke: () => {
      throw new Error("not implemented");
    },
    forget: () => {
      throw new Error("not implemented");
    },
    remember: () => {
      throw new Error("not implemented");
    },
    get: () => {
      throw new Error("not implemented");
    },
    list: async () => [],
    search: async () => ({ hits: [], coverage: "complete" }),
    resolvePreferences: async () => ({ preferences: [], truncated: false }),
    export: async () => ({ records: [], revisions: [], evidence: [], reviews: [], truncated: false }),
    usage: async () => ({ records: 0, bytes: 0 }),
    sweepExpired: async () => [],
    resolveFactConflicts: async () => [],
    ...overrides,
  };
}

/** A real `SkillManifest` shape (its two array fields are required by the output type, defaulted by the schema). */
function skillManifest(overrides: { readonly name: string; readonly description?: string }): SkillManifest {
  return { supportedRuntimeVersions: [], supportedToolContractVersions: [], ...overrides };
}

function fixtureSkills(overrides: Partial<SkillServicePort> = {}): SkillServicePort {
  return {
    import: () => {
      throw new Error("not implemented");
    },
    approve: () => {
      throw new Error("not implemented");
    },
    reject: () => {
      throw new Error("not implemented");
    },
    activate: () => {
      throw new Error("not implemented");
    },
    rollback: () => {
      throw new Error("not implemented");
    },
    disable: () => {
      throw new Error("not implemented");
    },
    list: async () => [],
    show: () => {
      throw new Error("not implemented");
    },
    listActive: async () => [],
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("builds a manifest with instructions, resolved preferences and no evidence when no query is given", async () => {
    const memory = fixtureMemory({
      resolvePreferences: async () => ({
        preferences: [
          {
            key: "ui.theme",
            value: "dark",
            winner: fixtureRecord({ scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" } }),
            overridden: [],
            conflict: false,
            conflictRecordIds: [],
          },
        ],
        truncated: false,
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "You are Tavi." });
    expect(manifest.instructions).toBe("You are Tavi.");
    expect(manifest.preferences).toEqual([{ key: "ui.theme", value: "dark", source: "personal_workspace", conflict: false }]);
    expect(manifest.evidence).toEqual([]);
    expect(manifest.evidenceTruncated).toBe(false);
    expect(manifest.tokenEstimate).toBeGreaterThan(0);
  });

  it("a run override outranks a stored preference for the same key", async () => {
    const memory = fixtureMemory({
      resolvePreferences: async () => ({
        preferences: [
          {
            key: "ui.theme",
            value: "dark",
            winner: fixtureRecord({ scope: { kind: "personal", principalId: "alice" } }),
            overridden: [],
            conflict: false,
            conflictRecordIds: [],
          },
        ],
        truncated: false,
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys", runOverrides: { "ui.theme": "light" } });
    expect(manifest.preferences).toEqual([{ key: "ui.theme", value: "light", source: "run", conflict: false }]);
  });

  it("retrieves bounded evidence when a query is given, and carries the search's conflict/superseded flags through as citations", async () => {
    const memory = fixtureMemory({
      search: async () => ({
        hits: [
          {
            recordId: "m1",
            revisionId: "r1",
            scope: { kind: "personal", principalId: "alice" },
            kind: "fact",
            snippet: "Alice keeps a garden",
            recordedAt: "2026-01-01T00:00:00.000Z",
            superseded: false,
            conflict: false,
          },
        ],
        coverage: "complete",
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys", query: "garden" });
    expect(manifest.evidence).toHaveLength(1);
    expect(manifest.evidence[0]?.recordId).toBe("m1");
    expect(manifest.evidenceTruncated).toBe(false);
  });

  it("does not retrieve evidence when no query is given", async () => {
    let searchCalled = false;
    const memory = fixtureMemory({
      search: async () => {
        searchCalled = true;
        return { hits: [], coverage: "complete" };
      },
    });
    await assembleContext({ memory }, { actor, instructions: "sys" });
    expect(searchCalled).toBe(false);
  });

  it("fails explicitly rather than silently truncating when the mandatory instructions alone exceed the budget", async () => {
    const memory = fixtureMemory();
    await expect(
      (async () => await assembleContext({ memory, maxTokens: 5 }, { actor, instructions: "x".repeat(1000) }))(),
    ).rejects.toThrowError(TaviError);
    await expect(
      (async () => await assembleContext({ memory, maxTokens: 5 }, { actor, instructions: "x".repeat(1000) }))(),
    ).rejects.toThrowError(/exceed the context budget/);
  });

  it("truncates evidence rather than exceeding the token budget, and reports it", async () => {
    const memory = fixtureMemory({
      search: async () => ({
        hits: Array.from({ length: 10 }, (_, index) => ({
          recordId: `m${index}`,
          revisionId: `r${index}`,
          scope: { kind: "personal" as const, principalId: "alice" },
          kind: "fact" as const,
          snippet: "x".repeat(200),
          recordedAt: "2026-01-01T00:00:00.000Z",
          superseded: false,
          conflict: false,
        })),
        coverage: "complete",
      }),
    });
    const manifest = await assembleContext({ memory, maxTokens: 100 }, { actor, instructions: "sys", query: "anything" });
    expect(manifest.evidence.length).toBeLessThan(10);
    expect(manifest.evidenceTruncated).toBe(true);
  });

  it("uses an injected token estimator instead of the default heuristic", async () => {
    const memory = fixtureMemory();
    let calls = 0;
    const estimateTokens = (text: string): number => {
      calls += 1;
      return text.length;
    };
    const manifest = await assembleContext({ memory, estimateTokens }, { actor, instructions: "abc" });
    expect(calls).toBeGreaterThan(0);
    // "abc" (3 chars); nothing else is assembled, and an empty preference list costs nothing.
    expect(manifest.tokenEstimate).toBe(3);
  });

  it("truncates preferences that do not fit and flags them, instead of failing", async () => {
    const memory = fixtureMemory();
    const manifest = await assembleContext(
      { memory, maxTokens: 40 },
      { actor, instructions: "sys", runOverrides: { key: "x".repeat(200) } },
    );
    expect(manifest.preferences).toEqual([]);
    expect(manifest.preferencesTruncated).toBe(true);
    expect(manifest.preferencesOmitted).toBe(1);
    expect(manifest.truncationNote).toBe("1 more preference not shown; memory.search finds them.");
    expect(manifest.tokenEstimate).toBeLessThanOrEqual(40);
  });

  it("3,000 preferences fit with a truncation line, conflicts and run overrides kept first", async () => {
    const preferences = Array.from({ length: 3_000 }, (_, index) => ({
      key: `pref.${index}`,
      value: `value ${index}`,
      winner: fixtureRecord({
        recordId: `p${index}`,
        scope: { kind: "personal", principalId: "alice" },
        updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }),
      overridden: [],
      conflict: index === 2_999,
      conflictRecordIds: index === 2_999 ? [`p${index}`, "other"] : [],
    }));
    const memory = fixtureMemory({ resolvePreferences: async () => ({ preferences, truncated: false }) });
    const manifest = await assembleContext({ memory, maxTokens: 2_000 }, { actor, instructions: "sys", runOverrides: { tone: "brief" } });
    expect(manifest.tokenEstimate).toBeLessThanOrEqual(2_000);
    expect(manifest.preferencesTruncated).toBe(true);
    expect(manifest.preferences.length).toBeGreaterThan(0);
    expect(manifest.preferencesOmitted).toBe(3_001 - manifest.preferences.length);
    // Conflicts first, then the run override, then the newest stored value.
    expect(manifest.preferences.slice(0, 3).map((preference) => preference.key)).toEqual(["pref.2999", "tone", "pref.2998"]);
    expect(manifest.truncationNote).toBe(`${manifest.preferencesOmitted} more preferences not shown; memory.search finds them.`);
  });

  it("flags a preference sweep that reached its bound, even when every preference it returned fits", async () => {
    const memory = fixtureMemory({ resolvePreferences: async () => ({ preferences: [], truncated: true }) });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys" });
    expect(manifest.preferencesTruncated).toBe(true);
    expect(manifest.preferencesOmitted).toBe(0);
    expect(manifest.truncationNote).toBe("More preferences not shown; memory.search finds them.");
  });

  it("budgets the sweep note, a conflict's note and the unavailable line it renders", async () => {
    const instructionsTokens = defaultEstimateTokens("sys");
    const shown = { key: "theme", value: "dark", source: "personal", conflict: false };
    const preference = (conflict: boolean) => ({
      key: "theme",
      value: "dark",
      winner: fixtureRecord(),
      overridden: [],
      conflict,
      conflictRecordIds: conflict ? ["a", "b"] : [],
    });
    const exact = instructionsTokens + defaultEstimateTokens(JSON.stringify(shown));

    const swept = await assembleContext(
      {
        memory: fixtureMemory({ resolvePreferences: async () => ({ preferences: [preference(false)], truncated: true }) }),
        maxTokens: exact,
      },
      { actor, instructions: "sys" },
    );
    expect(swept.preferences).toEqual([]);
    expect(swept.tokenEstimate).toBeLessThanOrEqual(exact);

    const conflicting = await assembleContext(
      {
        memory: fixtureMemory({ resolvePreferences: async () => ({ preferences: [preference(true)], truncated: false }) }),
        maxTokens: exact + defaultEstimateTokens(PREFERENCE_CONFLICT_NOTE) - 1,
      },
      { actor, instructions: "sys" },
    );
    expect(conflicting.preferences).toEqual([]);
    expect(conflicting.preferencesOmitted).toBe(1);

    const failed = await assembleContext(
      {
        memory: fixtureMemory({
          search: async () => {
            throw new Error("index unavailable");
          },
        }),
      },
      { actor, instructions: "sys", query: "garden" },
    );
    expect(failed.tokenEstimate).toBe(instructionsTokens + defaultEstimateTokens(MEMORY_UNAVAILABLE_LINE));
  });

  it("flags memory unavailable when search or the preference read throws, and still assembles the rest", async () => {
    const skills = fixtureSkills({
      listActive: async () => [{ skillId: "reporting", version: "1.0.0", manifest: skillManifest({ name: "Reporting helper" }) }],
    });
    const throwingSearch = fixtureMemory({
      search: async () => {
        throw new Error("index unavailable");
      },
    });
    const searched = await assembleContext({ memory: throwingSearch, skills }, { actor, instructions: "sys", query: "garden" });
    expect(searched.memoryUnavailable).toBe(true);
    expect(searched.memoryUnavailableReason).toBe("index unavailable");
    expect(searched.skills).toHaveLength(1);
    const throwingPreferences = fixtureMemory({
      resolvePreferences: async () => {
        throw new TaviError("INVALID_INPUT", "bad actor");
      },
    });
    const resolved = await assembleContext({ memory: throwingPreferences }, { actor, instructions: "sys" });
    expect(resolved.memoryUnavailable).toBe(true);
    const unreadable = fixtureMemory({ search: async () => ({ hits: [], coverage: "unavailable", reducedReason: "fts missing" }) });
    expect((await assembleContext({ memory: unreadable }, { actor, instructions: "sys", query: "garden" })).memoryUnavailable).toBe(true);
    expect((await assembleContext({ memory: fixtureMemory() }, { actor, instructions: "sys", query: "garden" })).memoryUnavailable).toBe(
      false,
    );
  });

  it("assembles skills with no memory service, reading no preference or evidence (memory paused or off)", async () => {
    const skills = fixtureSkills({
      listActive: async () => [{ skillId: "reporting", version: "1.0.0", manifest: skillManifest({ name: "Reporting helper" }) }],
    });
    const manifest = await assembleContext({ skills }, { actor, instructions: "sys", query: "garden" });
    expect(manifest.skills.map((skill) => skill.skillId)).toEqual(["reporting"]);
    expect(manifest.preferences).toEqual([]);
    expect(manifest.evidence).toEqual([]);
    expect(manifest.memoryUnavailable).toBe(false);
  });

  it("carries a hit's title and the records it conflicts with", async () => {
    const memory = fixtureMemory({
      search: async () => ({
        hits: [
          {
            recordId: "m1",
            revisionId: "r1",
            scope: { kind: "personal", principalId: "alice" },
            kind: "fact",
            title: "Flat",
            snippet: "Rent is 900",
            recordedAt: "2026-01-01T00:00:00.000Z",
            superseded: false,
            conflict: true,
            conflictsWith: ["m2"],
          },
        ],
        coverage: "complete",
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys", query: "rent" });
    expect(manifest.evidence[0]).toMatchObject({ title: "Flat", snippet: "Rent is 900", conflict: true, conflictsWith: ["m2"] });
  });

  it("includes a run override even when resolvePreferences never returned that key", async () => {
    const memory = fixtureMemory({ resolvePreferences: async () => ({ preferences: [], truncated: false }) });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys", runOverrides: { "notify.channel": "email" } });
    expect(manifest.preferences).toEqual([{ key: "notify.channel", value: "email", source: "run", conflict: false }]);
  });

  it("forwards preferenceKeys to resolvePreferences, and still lets an out-of-list run override through", async () => {
    const memory = fixtureMemory({
      resolvePreferences: async (input) => {
        expect(input.keys).toEqual(["ui.theme"]);
        return { preferences: [], truncated: false };
      },
    });
    const manifest = await assembleContext(
      { memory },
      {
        actor,
        instructions: "sys",
        preferenceKeys: ["ui.theme"],
        runOverrides: { "notify.channel": "email" },
      },
    );
    expect(manifest.preferences).toEqual([{ key: "notify.channel", value: "email", source: "run", conflict: false }]);
  });

  it("skills is empty when no skills service is configured, matching pre-wiring behavior", async () => {
    const memory = fixtureMemory();
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys" });
    expect(manifest.skills).toEqual([]);
  });

  it("lists each active skill's manifest, deriving a SkillActor from the same actor fields", async () => {
    const memory = fixtureMemory();
    const active: readonly ActiveSkill[] = [
      { skillId: "reporting", version: "1.0.0", manifest: skillManifest({ name: "Reporting helper", description: "Summarizes reports" }) },
    ];
    const skills = fixtureSkills({
      listActive: async (input) => {
        expect(input.actor).toEqual({ principalId: "alice", workspaceId: "w1", caller: "cli" });
        return active;
      },
    });
    const manifest = await assembleContext({ memory, skills }, { actor, instructions: "sys" });
    expect(manifest.skills).toEqual([
      { skillId: "reporting", version: "1.0.0", name: "Reporting helper", description: "Summarizes reports" },
    ]);
  });

  it("omits an undefined description rather than including it as undefined", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({
      listActive: async () => [{ skillId: "reporting", version: "1.0.0", manifest: skillManifest({ name: "Reporting helper" }) }],
    });
    const manifest = await assembleContext({ memory, skills }, { actor, instructions: "sys" });
    expect(manifest.skills).toEqual([{ skillId: "reporting", version: "1.0.0", name: "Reporting helper" }]);
    expect("description" in (manifest.skills[0] ?? {})).toBe(false);
  });

  it("truncates skills that do not fit and flags them, instead of failing", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({
      listActive: async () => [
        { skillId: "small", version: "1.0.0", manifest: skillManifest({ name: "Small" }) },
        { skillId: "z-reporting", version: "1.0.0", manifest: skillManifest({ name: "x".repeat(200) }) },
      ],
    });
    const manifest = await assembleContext({ memory, skills, maxTokens: 60 }, { actor, instructions: "sys" });
    expect(manifest.skills.map((skill) => skill.skillId)).toEqual(["small"]);
    expect(manifest.skillsTruncated).toBe(true);
    expect(manifest.skillsOmitted).toBe(1);
    expect(manifest.truncationNote).toBe("1 more skill not shown; skills.search finds them.");
  });

  it("lists skills by id with a short description, and past the cap the ones the query matches", async () => {
    const memory = fixtureMemory();
    const many = Array.from({ length: SKILL_LISTING_MAX + 5 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(2, "0")}`,
      version: "1.0.0",
      manifest: skillManifest({
        name: `Helper ${index}`,
        description: index === 29 ? "Files the quarterly expense report" : "d".repeat(400),
      }),
    }));
    const few = await assembleContext(
      { memory, skills: fixtureSkills({ listActive: async () => [...many.slice(0, 3)].reverse() }), maxTokens: 8_000 },
      { actor, instructions: "sys" },
    );
    expect(few.skills.map((skill) => skill.skillId)).toEqual(["skill-00", "skill-01", "skill-02"]);
    expect(few.skills[0]?.description).toHaveLength(SKILL_DESCRIPTION_MAX_CHARS);
    const lots = await assembleContext(
      { memory, skills: fixtureSkills({ listActive: async () => many }), maxTokens: 8_000 },
      { actor, instructions: "sys", query: "quarterly expense report" },
    );
    expect(lots.skills).toHaveLength(SKILL_LISTING_MAX);
    expect(lots.skills.map((skill) => skill.skillId)).toContain("skill-29");
    expect(lots.skillsOmitted).toBe(5);
    expect(lots.truncationNote).toBe("5 more skills not shown; skills.search finds them.");
  });

  it("past the cap leads with the recently used skills, reading usage once; within it, never reads usage and keeps id order", async () => {
    const memory = fixtureMemory();
    const many = Array.from({ length: SKILL_LISTING_MAX + 5 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(2, "0")}`,
      version: "1.0.0",
      manifest: skillManifest({ name: `Helper ${index}`, description: index === 27 ? "Books the team offsite" : "Does a thing" }),
    }));
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    let reads = 0;
    const skillUsage = {
      listUsage: async (scopeKey: string) => {
        reads += 1;
        expect(scopeKey).toBe("w1");
        return [
          { skillId: "skill-29", uses: 3, lastUsedAt: daysAgo(0) },
          { skillId: "skill-28", uses: 1, lastUsedAt: daysAgo(1) },
          // Used long ago: it weighs next to nothing.
          { skillId: "skill-26", uses: 40, lastUsedAt: daysAgo(80) },
        ];
      },
    };
    const lots = await assembleContext(
      { memory, skills: fixtureSkills({ listActive: async () => many }), skillUsage, maxTokens: 8_000 },
      { actor, instructions: "sys", query: "team offsite" },
    );
    expect(reads).toBe(1);
    const ids = lots.skills.map((skill) => skill.skillId);
    expect(ids).toHaveLength(SKILL_LISTING_MAX);
    // The query's match and the recently used, best first, then the rest by id.
    expect(ids.slice(0, 4)).toEqual(["skill-27", "skill-29", "skill-28", "skill-26"]);
    expect(ids.slice(4, 6)).toEqual(["skill-00", "skill-01"]);
    // With no query, recent use alone ranks them.
    const unasked = await assembleContext(
      { memory, skills: fixtureSkills({ listActive: async () => many }), skillUsage, maxTokens: 8_000 },
      { actor, instructions: "sys" },
    );
    expect(unasked.skills.slice(0, 3).map((skill) => skill.skillId)).toEqual(["skill-29", "skill-28", "skill-26"]);
    reads = 0;
    const few = await assembleContext(
      { memory, skills: fixtureSkills({ listActive: async () => [...many.slice(26, 30)].reverse() }), skillUsage, maxTokens: 8_000 },
      { actor, instructions: "sys", query: "team offsite" },
    );
    expect(reads).toBe(0);
    expect(few.skills.map((skill) => skill.skillId)).toEqual(["skill-26", "skill-27", "skill-28", "skill-29"]);
  });

  it("ranks by the query alone when the usage read fails", async () => {
    const memory = fixtureMemory();
    const many = Array.from({ length: SKILL_LISTING_MAX + 1 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(2, "0")}`,
      version: "1.0.0",
      manifest: skillManifest({ name: `Helper ${index}`, description: index === 25 ? "Books the team offsite" : "Does a thing" }),
    }));
    const manifest = await assembleContext(
      {
        memory,
        skills: fixtureSkills({ listActive: async () => many }),
        skillUsage: { listUsage: async () => Promise.reject(new Error("store gone")) },
        maxTokens: 8_000,
      },
      { actor, instructions: "sys", query: "team offsite" },
    );
    expect(manifest.skills[0]?.skillId).toBe("skill-25");
  });
});

/** An actor with `runId` set — the mailbox stage only runs when one is present (there's no task to peek a mailbox for otherwise); the rollout-enforcement stage also needs it to check `isAllowed`. */
const actorWithRun: MemoryActor = { ...actor, runId: "t-orchestrator" };

function fixtureSkillRollout(overrides: Partial<SkillRolloutRepositoryPort> = {}): SkillRolloutRepositoryPort {
  return {
    allow: () => {
      throw new Error("not implemented");
    },
    isAllowed: async () => false,
    isPinned: async () => false,
    listAllowed: async () => [],
    clear: () => {
      throw new Error("not implemented");
    },
    listPinnedVersions: async () => [],
    ...overrides,
  };
}

describe("assembleContext: bounded-rollout enforcement", () => {
  const active: readonly ActiveSkill[] = [
    { skillId: "reporting", version: "1.1.0", manifest: skillManifest({ name: "Reporting helper" }) },
  ];

  it("includes every active skill unconditionally when skillRollout is omitted, byte-identical to before this enforcement existed", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({ listActive: async () => active });
    const manifest = await assembleContext({ memory, skills }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.skills).toEqual([{ skillId: "reporting", version: "1.1.0", name: "Reporting helper" }]);
  });

  it("includes an active skill unconditionally when its triple is NOT pinned, regardless of the calling task", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({ listActive: async () => active });
    const skillRollout = fixtureSkillRollout({ isPinned: async () => false });
    const manifest = await assembleContext({ memory, skills, skillRollout }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.skills).toEqual([{ skillId: "reporting", version: "1.1.0", name: "Reporting helper" }]);
  });

  it("includes a PINNED skill for a task that IS on its allowlist", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({ listActive: async () => active });
    const skillRollout = fixtureSkillRollout({
      isPinned: async (input) => input.skillId === "reporting" && input.version === "1.1.0",
      isAllowed: async (input) => input.taskId === "t-orchestrator",
    });
    const manifest = await assembleContext({ memory, skills, skillRollout }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.skills).toEqual([{ skillId: "reporting", version: "1.1.0", name: "Reporting helper" }]);
  });

  it("OMITS a PINNED skill entirely for a task that is NOT on its allowlist — never falls back to an older version", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({ listActive: async () => active });
    const skillRollout = fixtureSkillRollout({
      isPinned: async () => true,
      isAllowed: async () => false,
    });
    const manifest = await assembleContext({ memory, skills, skillRollout }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.skills).toEqual([]);
  });

  it("OMITS a PINNED skill when the actor has no runId at all — fails closed rather than treating 'no task id' as authorized", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({ listActive: async () => active });
    const skillRollout = fixtureSkillRollout({
      isPinned: async () => true,
      isAllowed: () => {
        throw new Error("must not be called when runId is undefined");
      },
    });
    // `actor` (not `actorWithRun`) has no runId.
    const manifest = await assembleContext({ memory, skills, skillRollout }, { actor, instructions: "sys" });
    expect(manifest.skills).toEqual([]);
  });

  it("checks each active skill's own version, so a pin on one version doesn't affect a different version of the same skillId", async () => {
    const memory = fixtureMemory();
    const skills = fixtureSkills({
      listActive: async () => [{ skillId: "reporting", version: "1.2.0", manifest: skillManifest({ name: "Reporting helper" }) }],
    });
    const skillRollout = fixtureSkillRollout({
      // Pinned/restricted for 1.1.0 only, not the active 1.2.0.
      isPinned: async (input) => input.version === "1.1.0",
      isAllowed: async () => false,
    });
    const manifest = await assembleContext({ memory, skills, skillRollout }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.skills).toEqual([{ skillId: "reporting", version: "1.2.0", name: "Reporting helper" }]);
  });
});

function fixtureEnvelope(overrides: Partial<AgentMailboxEnvelopeRecord> = {}): AgentMailboxEnvelopeRecord {
  return {
    messageId: "msg-1",
    protocolVersion: 1,
    workspaceId: "w1",
    senderAgentId: "worker-a",
    senderTaskId: "t-worker-a",
    recipientAgentId: "orchestrator",
    recipientTaskId: "t-orchestrator",
    kind: "result",
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveryState: "pending",
    retentionState: "active",
    ...overrides,
  };
}

function fixtureMailbox(overrides: Partial<AgentMailboxRepositoryPort> = {}): AgentMailboxRepositoryPort {
  return {
    insertEnvelope: () => {
      throw new Error("not implemented");
    },
    getEnvelope: async () => undefined,
    listPending: async () => [],
    listByCorrelation: async () => [],
    claimForTurn: async () => ({ envelopes: [], more: 0 }),
    releaseClaim: async () => undefined,
    acknowledgeBefore: async () => 0,
    listSent: async () => [],
    claim: () => {
      throw new Error("not implemented");
    },
    acknowledge: () => {
      throw new Error("not implemented");
    },
    setDeliveryState: () => {
      throw new Error("not implemented");
    },
    setRetentionState: () => {
      throw new Error("not implemented");
    },
    ...overrides,
  };
}

describe("assembleContext: mailbox", () => {
  it("mailbox is empty when no mailbox port is configured, matching pre-wiring behavior", async () => {
    const memory = fixtureMemory();
    const manifest = await assembleContext({ memory }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.mailbox).toEqual([]);
    expect(manifest.mailboxTruncated).toBe(false);
  });

  it("mailbox is empty when the actor has no runId, even with a mailbox port configured", async () => {
    const memory = fixtureMemory();
    const mailbox = fixtureMailbox({ listPending: async () => [fixtureEnvelope()] });
    const manifest = await assembleContext({ memory, mailbox }, { actor, instructions: "sys" });
    expect(manifest.mailbox).toEqual([]);
  });

  it("lists pending mailbox messages for the actor's own task, carrying content/artifactId through", async () => {
    const memory = fixtureMemory();
    const mailbox = fixtureMailbox({
      listPending: async (taskId) => (taskId === "t-orchestrator" ? [fixtureEnvelope({ content: "status: done" })] : []),
    });
    const manifest = await assembleContext({ memory, mailbox }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.mailbox).toEqual([
      { messageId: "msg-1", senderAgentId: "worker-a", kind: "result", content: "status: done", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(manifest.mailboxTruncated).toBe(false);
  });

  it("carries artifactId through for an offloaded message with no inline content", async () => {
    const memory = fixtureMemory();
    const mailbox = fixtureMailbox({ listPending: async () => [fixtureEnvelope({ content: undefined, artifactId: "art-1" })] });
    const manifest = await assembleContext({ memory, mailbox }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.mailbox[0]?.artifactId).toBe("art-1");
    expect(manifest.mailbox[0]?.content).toBeUndefined();
  });

  it("truncates mailbox messages rather than exceeding the token budget, and reports it — five individually-small replies exceeding the cumulative budget", async () => {
    // Several
    // individually small messages must not overflow the prompt.
    const memory = fixtureMemory();
    const mailbox = fixtureMailbox({
      listPending: async () =>
        Array.from({ length: 5 }, (_, index) => fixtureEnvelope({ messageId: `msg-${index}`, content: "x".repeat(200) })),
    });
    const manifest = await assembleContext({ memory, mailbox, maxTokens: 100 }, { actor: actorWithRun, instructions: "sys" });
    expect(manifest.mailbox.length).toBeLessThan(5);
    expect(manifest.mailboxTruncated).toBe(true);
  });

  it("reads skills, preferences and the mailbox together, before the search", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memory = fixtureMemory({
      resolvePreferences: async () => {
        started.push("preferences");
        await gate;
        return { preferences: [], truncated: false };
      },
      search: async () => {
        started.push("search");
        return { hits: [], coverage: "complete" };
      },
    });
    const skills = fixtureSkills({
      listActive: async () => {
        started.push("skills");
        await gate;
        return [];
      },
    });
    const mailbox = fixtureMailbox({
      listPending: async () => {
        started.push("mailbox");
        await gate;
        return [];
      },
    });
    const assembled = assembleContext({ memory, skills, mailbox }, { actor: actorWithRun, instructions: "sys", query: "q" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...started].sort()).toEqual(["mailbox", "preferences", "skills"]);
    release();
    await assembled;
    expect(started.at(-1)).toBe("search");
  });

  describe("when several reads fail at once, the one read first in order still wins", () => {
    const failAfter = async (ms: number, message: string): Promise<never> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      throw new Error(message);
    };
    const roster: readonly ActiveSkill[] = [
      { skillId: "first", version: "1.0.0", manifest: skillManifest({ name: "First" }) },
      { skillId: "second", version: "1.0.0", manifest: skillManifest({ name: "Second" }) },
    ];

    it("assembleContext: the skills read's failure, though the mailbox's comes sooner", async () => {
      const skills = fixtureSkills({ listActive: async () => await failAfter(10, "skills failed") });
      const mailbox = fixtureMailbox({ listPending: async () => await failAfter(0, "mailbox failed") });
      await expect(
        assembleContext({ memory: fixtureMemory(), skills, mailbox }, { actor: actorWithRun, instructions: "sys" }),
      ).rejects.toThrow("skills failed");
    });

    it("collectContextRoutingCandidates: the mailbox read's failure, though the skills' comes sooner", async () => {
      const skills = fixtureSkills({ listActive: async () => await failAfter(0, "skills failed") });
      const mailbox = fixtureMailbox({ listPending: async () => await failAfter(10, "mailbox failed") });
      await expect(
        collectContextRoutingCandidates({ memory: fixtureMemory(), skills, mailbox }, { actor: actorWithRun, instructions: "sys" }),
      ).rejects.toThrow("mailbox failed");
    });

    it("rollout checks: the first skill's failure in roster order, though a later one's comes sooner", async () => {
      const skills = fixtureSkills({ listActive: async () => roster });
      const skillRollout = fixtureSkillRollout({
        isPinned: async ({ skillId }) => await failAfter(skillId === "first" ? 10 : 0, `${skillId} check failed`),
      });
      await expect(
        assembleContext({ memory: fixtureMemory(), skills, skillRollout }, { actor: actorWithRun, instructions: "sys" }),
      ).rejects.toThrow("first check failed");
    });
  });

  it("respects mailboxLimit as the cap passed to listPending", async () => {
    const memory = fixtureMemory();
    const seenLimits: number[] = [];
    const mailbox = fixtureMailbox({
      listPending: async (_taskId, limit) => {
        seenLimits.push(limit);
        return [];
      },
    });
    await assembleContext({ memory, mailbox, mailboxLimit: 5 }, { actor: actorWithRun, instructions: "sys" });
    expect(seenLimits).toEqual([5]);
  });
});

function routingFixture(
  decide?: (input: RouterDecisionInput) => Promise<Partial<RouterReceipt>>,
  mode: "off" | "shadow" | "active" = "active",
) {
  const settings = RouterSettingsSchema.parse({ enabled: mode !== "off", modes: { memory: mode, skills: mode } });
  const calls: RouterDecisionInput[] = [];
  const service: RouterPort = {
    configuration: async () => ({ revision: 1, settings }),
    disable() {},
    async dispose() {},
    async decide(input) {
      calls.push(input);
      return {
        decisionId: "d",
        operationId: input.operationId,
        taskId: input.fence.taskId,
        turnId: input.turnId,
        feature: input.feature,
        mode,
        providerId: "tavi.router",
        configRevision: 1,
        policyVersion: "v1",
        candidateHash: "0".repeat(64),
        permissionRevision: input.permissionRevision,
        state: "finished",
        reason: "selected",
        selectedIds: ["second"],
        probabilities: { second: 0.99 },
        cacheHit: false,
        elapsedMs: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        ...(await decide?.(input)),
      };
    },
  };
  return {
    calls,
    routing: {
      service,
      fence: { taskId: "task", generation: 1, ownerSession: "owner" },
      turnId: "turn",
      step: 0,
      signal: new AbortController().signal,
      isCurrent: () => true,
      prompt: "Use $explicit",
    },
  };
}
const routingHit = (recordId: string): MemorySearchHit => ({
  recordId,
  revisionId: "v1",
  scope: { kind: "personal", principalId: "alice" },
  kind: "fact",
  snippet: recordId.repeat(30),
  recordedAt: "2026-01-01T00:00:00.000Z",
  superseded: false,
  conflict: false,
});

describe("routed context", () => {
  it("ranks authorized evidence before budget truncation and preserves protected preferences", async () => {
    const f = routingFixture();
    const memory = fixtureMemory({ search: async () => ({ coverage: "complete", hits: [routingHit("first"), routingHit("second")] }) });
    const input = { actor, instructions: "mandatory", query: "q", runOverrides: { theme: "dark" } };
    const options = { memory, maxTokens: 120 };
    expect((await assembleContext(options, input)).evidence.map((hit) => hit.recordId)).toEqual(["first"]);
    const result = await assembleRoutedContext(options, input, f.routing);
    expect(result.evidence.map((hit) => hit.recordId)).toEqual(["second"]);
    expect(result.instructions).toBe("mandatory");
    expect(result.preferences[0]?.value).toBe("dark");
  });
  it.each(["off", "shadow"] as const)("keeps %s context byte-for-byte equal to the baseline", async (mode) => {
    const f = routingFixture(undefined, mode);
    const options = {
      memory: fixtureMemory({ search: async () => ({ coverage: "complete", hits: [routingHit("first"), routingHit("second")] }) }),
    };
    const input = { actor, instructions: "mandatory", query: "q" };
    expect(await assembleRoutedContext(options, input, f.routing)).toEqual(await assembleContext(options, input));
    if (mode === "off") expect(f.calls).toEqual([]);
  });
  it("drops revoked evidence and obsolete recommendations after inference", async () => {
    let hits = [routingHit("first"), routingHit("second")];
    const f = routingFixture(async () => {
      hits = [routingHit("first")];
      return {};
    });
    const result = await assembleRoutedContext(
      { memory: fixtureMemory({ search: async () => ({ coverage: "complete", hits }) }) },
      { actor, instructions: "mandatory", query: "q" },
      f.routing,
    );
    expect(result.evidence.map((entry) => entry.recordId)).toEqual(["first"]);
    expect(await f.calls[0]?.isCurrent()).toBe(false);
  });
  it("names its turn step on every memory read, so the owner asks the memory provider once", async () => {
    const f = routingFixture();
    const keys: (string | undefined)[] = [];
    const memory = fixtureMemory({
      search: async (input) => {
        keys.push(input.recallKey);
        return { coverage: "complete", hits: [routingHit("first"), routingHit("second")] };
      },
    });
    await assembleRoutedContext({ memory }, { actor, instructions: "mandatory", query: "q" }, { ...f.routing, turnId: "turn-7", step: 2 });
    // One candidate read before inference, one after it, and the assembly's own search.
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toEqual(new Set(["turn-7:2"]));
    // One the caller set is kept.
    keys.length = 0;
    await assembleRoutedContext({ memory }, { actor, instructions: "mandatory", query: "q", recallKey: "given" }, f.routing);
    expect(new Set(keys)).toEqual(new Set(["given"]));
  });
  it("reuses one candidate read for every currency check after inference, however many features ask", async () => {
    const f = routingFixture();
    let reads = 0;
    const memory = fixtureMemory({
      resolvePreferences: async () => {
        reads += 1;
        return { preferences: [], truncated: false };
      },
    });
    let projectionCurrent: (() => boolean | Promise<boolean>) | undefined;
    await assembleRoutedContext(
      { memory },
      { actor, instructions: "mandatory" },
      {
        ...f.routing,
        onProjection: (_data, isCurrent) => {
          projectionCurrent = isCurrent;
        },
      },
    );
    expect(f.calls.map((call) => call.feature)).toEqual(["memory", "skills"]);
    // Before inference, after it, and the assembly's own read.
    expect(reads).toBe(3);
    // The projection's check stays callable later, and reads again each time.
    expect(await projectionCurrent?.()).toBe(true);
    expect(reads).toBe(4);
  });
  it("reads the candidates once after a batch already asked the router, and still drops advice they changed under", async () => {
    let reads = 0;
    let hits = [routingHit("first"), routingHit("second")];
    const memory = fixtureMemory({
      search: async () => ({ coverage: "complete", hits }),
      resolvePreferences: async () => {
        reads += 1;
        return { preferences: [], truncated: false };
      },
    });
    const options = { memory, maxTokens: 120 };
    const input = { actor, instructions: "mandatory", query: "q" };
    // What the caller's batch does: prepare the questions, ask them, and keep the receipts.
    const prepare = async () => {
      const f = routingFixture();
      const plan = await prepareContextAdvice(options, input, f.routing);
      const receipts = await Promise.all(plan.inputs.map((question) => f.routing.service.decide(question)));
      return { routing: f.routing, prepared: plan.accept(receipts) };
    };
    const asked = await prepare();
    reads = 0;
    const routed = await assembleRoutedContext(options, input, { ...asked.routing, prepared: asked.prepared });
    // One post-inference candidate read, and the assembly's own read.
    expect(reads).toBe(2);
    expect(routed.evidence.map((hit) => hit.recordId)).toEqual(["second"]);

    // A record changed while the router thought is still caught by that one read: the advice is dropped.
    const stale = await prepare();
    hits = [routingHit("first"), { ...routingHit("second"), revisionId: "v2" }];
    const dropped = await assembleRoutedContext(options, input, { ...stale.routing, prepared: stale.prepared });
    expect(dropped.evidence.map((hit) => hit.recordId)).toEqual(["first"]);
    expect(dropped).toEqual(await assembleContext(options, input));
  });
  it("lets a batch's questions share one candidate read when the router checks them together", async () => {
    let reads = 0;
    const memory = fixtureMemory({
      resolvePreferences: async () => {
        reads += 1;
        return { preferences: [], truncated: false };
      },
    });
    const f = routingFixture();
    const plan = await prepareContextAdvice({ memory }, { actor, instructions: "mandatory" }, f.routing);
    expect(plan.inputs.map((question) => question.feature)).toEqual(["memory", "skills"]);
    reads = 0;
    expect(await Promise.all(plan.inputs.map((question) => question.isCurrent()))).toEqual([true, true]);
    expect(reads).toBe(1);
    // A later check reads again.
    expect(await plan.inputs[0]?.isCurrent()).toBe(true);
    expect(reads).toBe(2);
  });
  it("records a partial recall's reason in the manifest, as it does an unavailable one", async () => {
    const memory = fixtureMemory({
      search: async () => ({
        coverage: "partial",
        reducedReason: "memory provider acme.memory failed (transport); the host's own search answered",
        hits: [routingHit("first")],
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "sys", query: "q" });
    expect(manifest).toMatchObject({
      memoryUnavailable: false,
      evidenceReducedReason: "memory provider acme.memory failed (transport); the host's own search answered",
    });
    expect(manifest.evidence.map((entry) => entry.recordId)).toEqual(["first"]);
    expect(
      (await assembleContext({ memory: fixtureMemory() }, { actor, instructions: "sys", query: "q" })).evidenceReducedReason,
    ).toBeUndefined();
  });
  it("keeps the complete skill roster and explicitly requested eligible skill on abstention", async () => {
    const f = routingFixture(async () => ({ reason: "budget", selectedIds: [] }));
    const skills = fixtureSkills({
      listActive: async () =>
        ["explicit", "other"].map((skillId) => ({ skillId, version: "v1", manifest: skillManifest({ name: skillId }) })),
    });
    const result = await assembleRoutedContext({ memory: fixtureMemory(), skills }, { actor, instructions: "mandatory" }, f.routing);
    expect(await result.skills.map((skill) => skill.skillId)).toEqual(["explicit", "other"]);
    expect(result.recommendedSkills?.map((skill) => skill.skillId)).toEqual(["explicit"]);
  });
  it("keeps conflict handling deterministic when a different hit is recommended", async () => {
    const f = routingFixture();
    const result = await assembleRoutedContext(
      {
        memory: fixtureMemory({
          search: async () => ({ coverage: "complete", hits: [{ ...routingHit("first"), conflict: true }, routingHit("second")] }),
        }),
        maxTokens: 100,
      },
      { actor, instructions: "mandatory", query: "q" },
      f.routing,
    );
    expect(result.evidence.map((hit) => hit.recordId)).toEqual(["first"]);
  });
});

it("prioritizes explicit advice after eight provider recommendations and records the final projection", async () => {
  const f = routingFixture(async () => ({ selectedIds: Array.from({ length: 8 }, (_, i) => `skill${i}`) }));
  let projection: Pick<ContextProjectionSnapshot, "recommendedSkills" | "exposedSkills"> | undefined;
  const skills = fixtureSkills({
    listActive: async () =>
      Array.from({ length: 9 }, (_, i) => ({ skillId: `skill${i}`, version: "v1", manifest: skillManifest({ name: `skill${i}` }) })),
  });
  const manifest = await assembleRoutedContext(
    { memory: fixtureMemory(), skills },
    { actor, instructions: "sys" },
    {
      ...f.routing,
      prompt: "Use $skill8",
      onProjection: (value) => {
        projection = value;
      },
    },
  );
  expect(manifest.recommendedSkills?.some((skill) => skill.skillId === "skill8")).toBe(true);
  expect(projection?.recommendedSkills).toContainEqual({ skillId: "skill8", version: "v1" });
  expect(projection?.exposedSkills).toHaveLength(9);
});
it("omits optional advice before displacing baseline conflict evidence and records that omission", async () => {
  const f = routingFixture(async () => ({ selectedIds: Array.from({ length: 9 }, (_, i) => `skill${i}`) }));
  let projection: Pick<ContextProjectionSnapshot, "recommendedSkills" | "exposedSkills"> | undefined;
  const skills = fixtureSkills({
    listActive: async () =>
      Array.from({ length: 9 }, (_, i) => ({ skillId: `skill${i}`, version: "v1", manifest: skillManifest({ name: `s${i}` }) })),
  });
  const memory = fixtureMemory({
    search: async () => ({ coverage: "complete", hits: [{ ...routingHit("conflict"), snippet: "x".repeat(120), conflict: true }] }),
  });
  const options = { memory, skills, maxTokens: 180 };
  const input = { actor, instructions: "sys", query: "q" };
  const baseline = await assembleContext(options, input);
  const result = await assembleRoutedContext(options, input, {
    ...f.routing,
    onProjection: (value) => {
      projection = value;
    },
  });
  expect(baseline.evidence).toHaveLength(1);
  expect(result.evidence).toEqual(baseline.evidence);
  expect(projection?.recommendedSkills).toEqual([]);
  expect(projection?.exposedSkills).toHaveLength(9);
});

it("invalidates prepared context when a non-retrieved preference changes after inference", async () => {
  const f = routingFixture();
  let value = "old";
  let valid: (() => boolean | Promise<boolean>) | undefined;
  const memory = fixtureMemory({
    resolvePreferences: async () => ({
      preferences: [{ key: "theme", value, winner: fixtureRecord(), overridden: [], conflict: false, conflictRecordIds: [] }],
      truncated: false,
    }),
  });
  await assembleRoutedContext(
    { memory },
    { actor, instructions: "sys", query: "unrelated" },
    {
      ...f.routing,
      onProjection: async (_data, isCurrent) => {
        valid = isCurrent;
      },
    },
  );
  expect(await valid?.()).toBe(true);
  value = "corrected";
  expect(await valid?.()).toBe(false);
});

it("invalidates prepared routed context when a profile entry changes after router inference", async () => {
  const f = routingFixture();
  let profileSnippet = "When editing code, show a diff first.";
  let valid: (() => boolean | Promise<boolean>) | undefined;
  const memory = fixtureMemory({
    resolvePreferences: async () => ({
      preferences: [],
      truncated: false,
      profile: [
        {
          recordId: "les-1",
          revisionId: "rev-1",
          kind: "lesson",
          scope: { kind: "personal", principalId: "alice" },
          snippet: profileSnippet,
          recordedAt: "2026-01-01T00:00:00.000Z",
          usedChats: 1,
          conflict: false,
        },
      ],
    }),
  });
  await assembleRoutedContext(
    { memory },
    { actor, instructions: "sys", query: "q" },
    {
      ...f.routing,
      onProjection: async (_data, isCurrent) => {
        valid = isCurrent;
      },
    },
  );
  expect(await valid?.()).toBe(true);
  profileSnippet = "When editing code, run tests first.";
  expect(await valid?.()).toBe(false);
});

describe("profile assembly (About the person)", () => {
  it("budgets lessons and core me.* facts within 12 entries and 600 tokens, counting omitted entries in truncationNote", async () => {
    const profileEntries = Array.from({ length: 14 }, (_, index) => ({
      recordId: `les-${index + 1}`,
      revisionId: `rev-${index + 1}`,
      kind: "lesson" as const,
      scope: { kind: "personal" as const, principalId: "alice" },
      title: `Lesson ${index + 1}`,
      snippet: `When situation ${index + 1} arises, follow step ${index + 1}.`,
      recordedAt: "2026-01-01T00:00:00.000Z",
      usedChats: 14 - index,
      conflict: false,
    }));
    const memory = fixtureMemory({
      resolvePreferences: async () => ({
        preferences: [],
        truncated: false,
        profile: profileEntries,
      }),
    });
    const manifest = await assembleContext({ memory }, { actor, instructions: "You are Tavi." });
    expect(manifest.profile).toHaveLength(12);
    expect(manifest.profileTruncated).toBe(true);
    expect(manifest.profileOmitted).toBe(2);
    expect(manifest.truncationNote).toBe("2 more lessons not shown; memory.search finds them.");
  });
});
