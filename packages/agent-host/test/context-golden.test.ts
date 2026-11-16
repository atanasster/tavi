import {
  RouterSettingsSchema,
  type ActiveSkill,
  type AgentMailboxEnvelopeRecord,
  type AgentMailboxRepositoryPort,
  type MemoryActor,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemoryServicePort,
  type ResolvedPreference,
  type ResolvedProfileEntry,
  type RouterPort,
  type SkillRolloutRepositoryPort,
  type SkillServicePort,
} from "@tavi/contracts";
import { expect, it } from "vitest";

import {
  assembleContext,
  assembleRoutedContext,
  type ContextAssemblerOptions,
  type AssembleContextInput,
  type ContextRouting,
} from "../src/context/context.js";
import { contextBlockText, renderContextManifest } from "../src/workflow/context-block.js";

/**
 * The context block, byte for byte, for a set of fixture chats.
 *
 * Context reads run concurrently (`assembleContext`'s independent reads, the
 * routed path's single pre- and post-inference candidate reads), but the block they
 * produce is fitted in one deterministic order: this golden file pins it.
 * A change here is a change to what every model call sees.
 */

const actor: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator", runId: "t-1" };
const scope = { kind: "personal", principalId: "alice" } as const;
const at = "2026-01-01T00:00:00.000Z";

const hit = (recordId: string, snippet: string, extra: Partial<MemorySearchHit> = {}): MemorySearchHit => ({
  recordId,
  revisionId: `${recordId}-r1`,
  scope,
  kind: "fact",
  snippet,
  recordedAt: at,
  superseded: false,
  conflict: false,
  ...extra,
});

const preference = (key: string, value: unknown, conflict = false): ResolvedPreference => ({
  key,
  value,
  winner: {
    recordId: `pref-${key}`,
    kind: "preference",
    scope,
    scopeKey: "personal|p=alice",
    status: "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: at,
    updatedAt: at,
  },
  overridden: [],
  conflict,
  conflictRecordIds: conflict ? [`pref-${key}`, "other"] : [],
});

const profileEntry = (recordId: string, kind: "lesson" | "fact", snippet: string): ResolvedProfileEntry => ({
  recordId,
  revisionId: `${recordId}-r1`,
  kind,
  scope,
  snippet,
  recordedAt: at,
  usedChats: 2,
  conflict: false,
});

interface MemoryFixture {
  readonly preferences?: readonly ResolvedPreference[];
  readonly profile?: readonly ResolvedProfileEntry[];
  readonly hits?: readonly MemorySearchHit[];
  readonly coverage?: MemorySearchResult["coverage"];
  readonly reducedReason?: string;
  readonly failPreferences?: boolean;
  readonly failSearch?: boolean;
}

/** Only the two reads context assembly makes; the search honours `limit`, as the real one does. */
function memoryOf(fixture: MemoryFixture): MemoryServicePort {
  const reads: Pick<MemoryServicePort, "search" | "resolvePreferences"> = {
    search: async (input) => {
      if (fixture.failSearch) throw new Error("index locked");
      const hits = [...(fixture.hits ?? [])].slice(0, input.limit ?? 8);
      return {
        hits,
        coverage: fixture.coverage ?? "complete",
        ...(fixture.reducedReason === undefined ? {} : { reducedReason: fixture.reducedReason }),
      };
    },
    resolvePreferences: async () => {
      if (fixture.failPreferences) throw new Error("database is busy");
      return { preferences: fixture.preferences ?? [], truncated: false, profile: fixture.profile ?? [] };
    },
  };
  return reads as MemoryServicePort;
}

const active: readonly ActiveSkill[] = [
  {
    skillId: "deploy",
    version: "1.0.0",
    manifest: { name: "Deploy", description: "Ship a release", supportedRuntimeVersions: [], supportedToolContractVersions: [] },
  },
  { skillId: "notes", version: "2.1.0", manifest: { name: "Notes", supportedRuntimeVersions: [], supportedToolContractVersions: [] } },
  {
    skillId: "pinned-in",
    version: "3.0.0",
    manifest: { name: "Pinned in", description: "On the allowlist", supportedRuntimeVersions: [], supportedToolContractVersions: [] },
  },
  {
    skillId: "pinned-out",
    version: "3.0.0",
    manifest: { name: "Pinned out", description: "Not on the allowlist", supportedRuntimeVersions: [], supportedToolContractVersions: [] },
  },
];
const skills = { listActive: async () => active } as Pick<SkillServicePort, "listActive"> as SkillServicePort;
const skillRollout = {
  isPinned: async ({ skillId }) => skillId.startsWith("pinned-"),
  isAllowed: async ({ skillId }) => skillId === "pinned-in",
} as Pick<SkillRolloutRepositoryPort, "isPinned" | "isAllowed"> as SkillRolloutRepositoryPort;

const envelope = (messageId: string, content: string): AgentMailboxEnvelopeRecord => ({
  messageId,
  protocolVersion: 1,
  workspaceId: "w1",
  senderAgentId: "worker-a",
  senderTaskId: "t-worker-a",
  recipientAgentId: "orchestrator",
  recipientTaskId: "t-1",
  kind: "progress",
  content,
  createdAt: at,
  deliveryState: "pending",
  retentionState: "active",
});
const mailbox = {
  listPending: async () => [envelope("msg-1", "status: indexing done"), envelope("msg-2", "status: tests running")],
} as Pick<AgentMailboxRepositoryPort, "listPending"> as AgentMailboxRepositoryPort;

const richMemory: MemoryFixture = {
  preferences: [preference("ui.theme", "dark"), preference("tone", "brief", true)],
  profile: [profileEntry("les-1", "lesson", "Show a diff before editing."), profileEntry("me-1", "fact", "Alice lives in Sofia.")],
  hits: [
    hit("me-1", "Alice lives in Sofia."),
    hit("m-2", "The garden has tomatoes."),
    hit("m-3", "Alice prefers rsync.", { conflict: true, conflictsWith: ["m-9"] }),
    hit("m-4", "Old address.", { superseded: true }),
  ],
};

function router(mode: "off" | "shadow" | "active"): ContextRouting {
  const settings = RouterSettingsSchema.parse({ enabled: mode !== "off", modes: { memory: mode, skills: mode } });
  const service: RouterPort = {
    configuration: async () => ({ revision: 1, settings }),
    disable() {},
    async dispose() {},
    async decide(input) {
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
        selectedIds: ["m-2", "notes"],
        probabilities: { "m-2": 0.9 },
        cacheHit: false,
        elapsedMs: 1,
        startedAt: at,
      };
    },
  };
  return {
    service,
    fence: { taskId: "t-1", generation: 1, ownerSession: "owner" },
    turnId: "turn",
    step: 0,
    signal: new AbortController().signal,
    isCurrent: () => true,
    prompt: "Use $deploy",
  };
}

const base = { actor, instructions: "You are Tavi." };
const query = { query: "garden address", queryMatch: "any", applyFloor: true } as const;

const chats: readonly {
  readonly name: string;
  readonly options: ContextAssemblerOptions;
  readonly input: AssembleContextInput;
  readonly routing?: ContextRouting;
}[] = [
  { name: "instructions only", options: {}, input: base },
  {
    name: "everything fits",
    options: { memory: memoryOf(richMemory), skills, skillRollout, mailbox },
    input: { ...base, ...query, runOverrides: { "ui.theme": "light" } },
  },
  {
    name: "profile overlap widens a tight evidence limit",
    options: { memory: memoryOf(richMemory), skills, mailbox },
    input: { ...base, ...query, evidenceLimit: 1 },
  },
  {
    name: "tight budget truncates every section",
    options: { memory: memoryOf(richMemory), skills, skillRollout, mailbox, maxTokens: 150 },
    input: { ...base, ...query },
  },
  {
    name: "preferences fail, recall partial",
    options: {
      memory: memoryOf({ ...richMemory, failPreferences: true, coverage: "partial", reducedReason: "provider timed out" }),
      skills,
      mailbox,
    },
    input: { ...base, ...query },
  },
  {
    name: "preferences and search both fail",
    options: { memory: memoryOf({ ...richMemory, failPreferences: true, failSearch: true }), mailbox },
    input: { ...base, ...query },
  },
  {
    name: "search unavailable",
    options: { memory: memoryOf({ ...richMemory, coverage: "unavailable", reducedReason: "index rebuilding" }), skills },
    input: { ...base, ...query },
  },
  {
    name: "no query, profile off",
    options: { memory: memoryOf(richMemory), skills, skillRollout, mailbox },
    input: { ...base, includeProfile: false },
  },
  {
    name: "memory off keeps skills and mailbox",
    options: { skills, skillRollout, mailbox },
    input: { ...base, ...query },
  },
  {
    name: "routed, router off",
    options: { memory: memoryOf(richMemory), skills, skillRollout, mailbox },
    input: { ...base, ...query },
    routing: router("off"),
  },
  {
    name: "routed, router active",
    options: { memory: memoryOf(richMemory), skills, skillRollout, mailbox },
    input: { ...base, ...query },
    routing: router("active"),
  },
];

it("renders the same context block for every fixture chat", async () => {
  const blocks: string[] = [];
  for (const chat of chats) {
    const manifest =
      chat.routing === undefined
        ? await assembleContext(chat.options, chat.input)
        : await assembleRoutedContext(chat.options, chat.input, chat.routing);
    blocks.push(`=== ${chat.name} (tokenEstimate ${manifest.tokenEstimate}) ===\n${contextBlockText(renderContextManifest(manifest))}\n`);
  }
  await expect(blocks.join("\n")).toMatchFileSnapshot("./golden/context-blocks.txt");
});
