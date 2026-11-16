import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

/**
 * Named agent definitions — the persona registry.
 *
 * `AgentSpawnInput.agentDefinitionId` is an opaque reference
 * (`packages/contracts/src/agent-communication.ts`); this registry is what it
 * resolves to. Without it every task — orchestrator, worker, scheduled
 * brief — would run with identical instructions; here a name (an
 * orchestrator agent *named* `sdaddy`) becomes a persona.
 *
 * **An agent definition is instructions, not authority.** It carries no tool
 * allowlist and no credential, deliberately: what a task may *do* unattended is
 * the schedule's policy and what it may *read* is the workspace
 * grant, both operator-authored and both enforced where the effect happens.
 * Keeping the persona free of authority means adding an agent cannot widen
 * anything, which is what makes a registry safe to let an operator populate
 * freely.
 *
 * The id stays a **reference** — the pattern `skillId` uses — rather than the
 * prompt text being snapshotted into a task. A task therefore picks up an
 * operator's edit to the persona on its next turn, which is the behaviour an
 * operator expects when they fix a badly-worded instruction; the cost is that
 * removing a definition mid-task degrades that task to the base prompt
 * (admission validates the reference, so a *new* task can never start with an
 * unknown one).
 */

/**
 * A definition's identity and instructions.
 *
 * `strictObject` so a typo in a config file is a visible error rather than a
 * silently-ignored key — the same reasoning `ScheduleSpecSchema` follows.
 */
export const AgentDefinitionSchema = z.strictObject({
  agentId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, "expected a letter, digit, dot, dash or underscore")
    .describe("Stable id an operator names at admission, e.g. `sdaddy`"),
  workspaceId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000).optional().describe("One line on what this agent is for, shown by `tavi agents show`"),
  /**
   * The persona itself. Bounded generously (20 000 characters) because this is
   * an operator's written instructions, not a model-generated value — but
   * bounded, because it is prepended to every model call for every turn of
   * every task that names this agent, and an unbounded prompt is an unbounded
   * cost.
   */
  systemPrompt: z.string().min(1).max(20_000),
  /** Validated rather than coerced, for the reason `ProjectRecordSchema` states. */
  enabled: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  /** A real instant: `''` and `'now'` both used to validate here. */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export interface CreateAgentDefinitionInput {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly enabled: boolean;
  readonly now: string;
}

/**
 * Durable storage for agent definitions.
 *
 * Scoped by workspace, like schedules: two workspaces may each have their own
 * `sdaddy` with different instructions, and neither can see the other's.
 */
interface AgentDefinitionRepositoryPortDefinition {
  /**
   * Refuses a duplicate `(workspaceId, agentId)` with a typed `CONFLICT`, and
   * refuses a definition outside `AgentDefinitionSchema` with `INVALID_INPUT`
   * **before writing**.
   */
  create(input: CreateAgentDefinitionInput): AgentDefinition;
  /**
   * Throws a typed `INTERNAL` naming the row if it does not match
   * `AgentDefinitionSchema`.
   *
   * Validated on the way out, like the schedule and project rows: an unvalidated
   * read would put an id that violates the documented pattern, or an unbounded
   * `systemPrompt`, into the persona prepended to every model call of every turn
   * of every task naming it.
   */
  get(workspaceId: string, agentId: string): AgentDefinition | undefined;
  /**
   * `unreadable` holds one `` `${workspaceId}/${agentId}` `` key per row that
   * failed validation, isolated and reported rather than thrown — one bad row
   * must not hide every definition, and must not vanish silently either. The
   * key is workspace-qualified because this listing is
   * deliberately cross-workspace when `workspaceId` is omitted, so an id alone
   * cannot say which row to repair.
   *
   * @example `{ agents: [...], unreadable: ["default/sdaddy"] }`
   */
  list(workspaceId?: string): { readonly agents: readonly AgentDefinition[]; readonly unreadable: readonly string[] };
  remove(workspaceId: string, agentId: string): boolean;
  /**
   * Operator-editable fields. Returns `false` for an unknown id, and throws
   * `INVALID_INPUT` for a value outside `AgentDefinitionSchema` — it never
   * reports success for a write that would make the row unreadable.
   *
   * With `expectedUpdatedAt` the write is a compare-and-set: a row whose
   * `updatedAt` differs is refused with `CONFLICT` (details carry the current
   * `updatedAt`, never the prompt). `updatedAt` is the definition's version, so
   * every write moves it strictly forward — past the stored instant when `now`
   * is not later — and two writes can never leave the same token behind.
   */
  update(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly name?: string;
    readonly description?: string | null;
    readonly systemPrompt?: string;
    readonly enabled?: boolean;
    readonly expectedUpdatedAt?: string;
    readonly now: string;
  }): boolean;
}

export type AgentDefinitionRepositoryPort = AsyncRepository<AgentDefinitionRepositoryPortDefinition>;
