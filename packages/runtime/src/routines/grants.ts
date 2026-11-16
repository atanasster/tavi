import { providerOperation } from "../plugin-host/provider-bindings.js";
import { assertPublicDestination, boundPublicFetch, egressHostRefusal, resolveFetchBinding, urlRefusal } from "../fetch-tool.js";
import { hostRefusal } from "../host-policy.js";
import { z } from "zod";
import {
  ROUTINE_PRIMARY_SOURCE_POLICY,
  RoutineGrantSchema,
  TaviError,
  isKnownUrl,
  isWideningNetworkMode,
  normalizeUrl,
  type ModelPort,
  type RoutineEnvelope,
  type RoutineFence,
  type RoutineGrant,
  type RoutineGrantDenial,
  type RoutineGrantResolution,
  type RoutineGrantView,
  type RoutineNetworkMode,
  type RoutineRun,
  type RoutineScope,
  type RoutineSnapshot,
  type RoutineStep,
  type ToolRegistryPort,
} from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import { canonicalRoutineJson, routineHash, type RoutineService } from "./service.js";
import type { RoutineExecutionService } from "../persistence/routine-facades.js";

type RoutineDatabase = RoutineService["store"]["handle"];

/** The effect-specific claim an authority check evaluates. */
export interface RoutineGrantEffect {
  readonly grantId?: string | null;
  readonly tool?: string;
  readonly url?: string;
  readonly destinationId?: string;
}

/**
 * The research tools the routine surface can offer under `mode`, before the run's
 * own declared list narrows them.
 *
 * One list, because two modules must agree on it: `routineResearchTools` decides
 * what the model may *see* and `routineGrantableTools` decides what an effect may
 * *run*. A tool added to one and not the other would be offered and then refused
 * (or never offered at all).
 *
 * `web_fetch` is the guarded public-retrieval path, and it exists only under
 * a mode that widens beyond the revision's own host list. In `allowlist` mode it
 * would be an alias for `http.request`, so it is not offered.
 */
function routineGrantableToolIds(mode: RoutineNetworkMode, pluginReads: readonly string[] = []): readonly string[] {
  return [...(isWideningNetworkMode(mode) ? ["web_search", "http.request", "web_fetch"] : ["web_search", "http.request"]), ...pluginReads];
}

/**
 * The plugin tools a routine's research step may be granted: an external plugin's tool,
 * read-only, whose manifest declares its sink `search` or `none` — a
 * query to a third party, or nothing sent at all. Never a built-in, never an
 * MCP server's tool, never one on the external default `network` sink. A
 * revision still names each one it uses, and its run's grant pins them.
 */
export function routinePluginReads(tools: {
  list(): readonly { readonly id: string }[];
  get(id: string):
    | {
        readonly effect: string;
        readonly sink?: string | undefined;
        readonly builtIn?: true | undefined;
        readonly outputSource?: string | undefined;
      }
    | undefined;
}): readonly string[] {
  // Each read through `get`: the registry's own record says what is built in, which `list` leaves out.
  return tools
    .list()
    .map((listed) => [listed.id, tools.get(listed.id)] as const)
    .filter(
      ([, tool]) =>
        tool !== undefined &&
        tool.builtIn !== true &&
        tool.outputSource === "plugin" &&
        tool.effect === "read-only" &&
        (tool.sink === "search" || tool.sink === "none"),
    )
    .map(([id]) => id)
    .sort();
}

/**
 * The tools an effect of `step` may use, as the *effective* set: the routine
 * orchestration allowlist, then the run's pinned snapshot policy, then the grant.
 * The grant's `researchTools` are copied from the run's immutable snapshot at
 * admission, so intersecting the two adds nothing the grant does not already say;
 * the research adapter applies the same bound through `routineGrantableToolIds`.
 * Synthesis control tools are the routine orchestration's own (`agents.spawn`),
 * not the research list.
 */
export function routineGrantableTools(
  step: RoutineStep,
  grant: Pick<RoutineGrant, "researchTools">,
  snapshot: RoutineSnapshot,
  pluginReads: readonly string[] = [],
): readonly string[] {
  if (step === "synthesis") return ["agents.spawn"];
  return routineGrantableToolIds(snapshot.permissions.networkMode, pluginReads).filter((tool) => grant.researchTools.includes(tool));
}

type GrantRow = {
  grant_id: string;
  run_id: string;
  routine_id: string;
  workspace_id: string;
  principal_id: string;
  revision: number;
  policy_revision: number;
  mode: "production" | "preview";
  grant_json: string;
  grant_hash: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

/** What a grant check consults beside storage: the owner's live authority and the plugin reads it may grant now. */
export interface RoutineGrantAuthority {
  readonly authorized: (run: RoutineRun, step: RoutineStep) => boolean;
  readonly pluginReads?: () => readonly string[];
}

/** A refused effect's resolution: the typed denial and what was refused. */
type GrantDenial = { readonly code: RoutineGrantDenial; readonly detail: string };

/** Pins the immutable policy intersection a run's effects resolve against. */
export function pinRoutineGrant(
  db: RoutineDatabase,
  scope: RoutineScope,
  run: { readonly runId: string; readonly routineId: string; readonly revision: number; readonly mode: "production" | "preview" },
  snapshot: RoutineSnapshot,
  now: string,
): RoutineGrant {
  const grant: RoutineGrant = {
    version: 1,
    grantId: prefixedId("routine-grant"),
    runId: run.runId,
    routineId: run.routineId,
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    revision: run.revision,
    policyRevision: snapshot.permissions.revision,
    mode: run.mode,
    researchTools: [...snapshot.permissions.researchTools].sort(),
    allowedHosts: [...snapshot.permissions.allowedHosts].sort(),
    networkMode: snapshot.permissions.networkMode,
    // The curated primary-source list is policy: version it into the grant so a
    // reader can tell which list produced this run's authority, and so editing
    // the list is visible as a difference rather than silent.
    ...(snapshot.permissions.networkMode === "primary_sources"
      ? { primarySourcePolicyVersion: ROUTINE_PRIMARY_SOURCE_POLICY.version }
      : {}),
    destinationIds: [...snapshot.delivery.targetIds].sort(),
    createdAt: now,
  };
  db.prepare(
    "INSERT INTO tavi_routine_grants (grant_id,run_id,routine_id,workspace_id,principal_id,revision,policy_revision,mode,grant_json,grant_hash,created_at,revoked_at,revoked_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
  ).run(
    grant.grantId,
    run.runId,
    run.routineId,
    scope.workspaceId,
    scope.principalId,
    run.revision,
    grant.policyRevision,
    run.mode,
    canonicalRoutineJson(grant),
    routineHash(grant),
    now,
  );
  return grant;
}

function grantRow(db: RoutineDatabase, runId: string): GrantRow | undefined {
  return db.prepare("SELECT * FROM tavi_routine_grants WHERE run_id=?").get(runId) as GrantRow | undefined;
}

/**
 * Load the pinned grant a run's effects resolve against.
 *
 * The grant intersection is computed from three sources, and only one of
 * them is in memory: the grant persisted at admission (read back from storage,
 * never the caller's copy), the run's own *pinned snapshot* policy
 * (`permissions.researchTools` / `permissions.allowedHosts` — the revision the
 * run was admitted under, not whatever the routine looks like now), and current
 * revocations (`revoked_at` plus the owner's live workspace/tool authority).
 *
 * Deliberate narrowings on top of that intersection, all of them matching the
 * `http.request` tool the research adapter exposes: only `https:` (or `http:`
 * for a loopback host, as the tool allows), no userinfo, no redirects. Host
 * matching is *the operator's allowlist language*, not a private re-implementation
 * — `hostRefusal` is the same predicate the HTTP tool uses, so an operator's
 * `host:port` or `*.suffix` entry means the same thing here as there.
 *
 * Every failure closes with a typed denial; none waits for an approval.
 */
function loadGrant(
  db: RoutineDatabase,
  run: RoutineRun,
): { grant: RoutineGrant; row: GrantRow } | { denial: RoutineGrantDenial; detail: string } {
  if (run.grantId === null) return { denial: "grant-absent", detail: "Run was admitted without a durable grant" };
  const row = grantRow(db, run.runId);
  if (row === undefined || row.grant_id !== run.grantId) return { denial: "grant-absent", detail: "Run's durable grant is missing" };
  if (
    row.run_id !== run.runId ||
    row.routine_id !== run.routineId ||
    row.workspace_id !== run.workspaceId ||
    row.principal_id !== run.principalId ||
    row.revision !== run.revision ||
    row.mode !== run.mode
  )
    return { denial: "grant-scope-mismatch", detail: "Grant record belongs to another run, revision or scope" };
  let grant: RoutineGrant;
  try {
    grant = RoutineGrantSchema.parse(JSON.parse(row.grant_json));
  } catch {
    return { denial: "grant-mismatch", detail: "Grant record is not a readable grant" };
  }
  if (routineHash(grant) !== row.grant_hash) return { denial: "grant-mismatch", detail: "Grant record does not match its recorded hash" };
  // The row is the authority, but the JSON inside it must agree: a future
  // migration or repair that updates one and not the other would otherwise
  // resolve as valid while the inspector showed a different revision.
  if (
    grant.grantId !== row.grant_id ||
    grant.runId !== run.runId ||
    grant.routineId !== run.routineId ||
    grant.workspaceId !== run.workspaceId ||
    grant.principalId !== run.principalId ||
    grant.revision !== row.revision ||
    grant.policyRevision !== row.policy_revision ||
    grant.mode !== row.mode
  ) {
    return { denial: "grant-mismatch", detail: "Grant record disagrees with the run it is pinned to" };
  }
  return { grant, row };
}

/** Evaluate one effect against the loaded grant. Read-only; callers decide how to refuse. */
export function evaluateRoutineGrant(
  db: RoutineDatabase,
  authority: RoutineGrantAuthority,
  run: RoutineRun,
  step: RoutineStep,
  effect?: RoutineGrantEffect,
): RoutineGrantResolution {
  const deny = (code: RoutineGrantDenial, detail: string): RoutineGrantResolution => ({ allowed: false, code, detail });
  const loaded = loadGrant(db, run);
  if ("denial" in loaded) return deny(loaded.denial, loaded.detail);
  const { grant, row } = loaded;
  // An effect that carries an identity claim must match the pinned grant;
  // absence of the key means "no claim", absence of a grant fails closed above.
  if (effect !== undefined && "grantId" in effect && effect.grantId !== grant.grantId)
    return deny("grant-mismatch", "Effect carries a stale grant identity");
  if (row.revoked_at !== null) return deny("grant-revoked", row.revoked_reason ?? "Grant was revoked");
  if (!authority.authorized(run, step)) return deny("authority-withdrawn", "Current workspace or tool authority no longer covers this run");
  if (effect?.tool !== undefined) {
    const allowed = routineGrantableTools(step, grant, run.snapshot, authority.pluginReads?.() ?? []).includes(effect.tool);
    if (!allowed) return deny("tool-outside-grant", `Tool ${effect.tool} is outside the run's grant`);
  }
  if (effect?.url !== undefined) {
    const refusal = urlGrantRefusal(grant, { ...effect, url: effect.url });
    if (refusal !== undefined) return refusal;
  }
  if (effect?.destinationId !== undefined) {
    // The grant's list *is* the revision's `delivery.targetIds` as pinned at
    // admission, so it is the whole check: re-reading the run's snapshot here
    // would add nothing the grant does not already say.
    if (!grant.destinationIds.includes(effect.destinationId))
      return deny("destination-outside-grant", `Destination ${effect.destinationId} is outside the run's grant`);
  }
  return { allowed: true, grant };
}

/**
 * The host half of one fetch effect.
 *
 * `web_fetch` is checked against the mode's policy (the curated primary-source
 * list, the operator's list, or any public host) and then against the structural
 * rules no mode relaxes; `http.request` keeps the operator's allowlist. The
 * *address* half lives in the tool, immediately before the exchange.
 *
 * The pinned list is the whole check: the grant copies the run's
 * `permissions.allowedHosts` and `networkMode` verbatim at admission and the
 * snapshot is immutable afterwards, so there is no second, "current" list that
 * could refuse an effect the pinned list allowed.
 */
function urlGrantRefusal(grant: RoutineGrant, effect: RoutineGrantEffect & { url: string }): RoutineGrantResolution | undefined {
  const deny = (code: RoutineGrantDenial, detail: string): RoutineGrantResolution => ({ allowed: false, code, detail });
  if (effect.tool === "web_fetch") {
    let parsed: URL;
    try {
      parsed = new URL(effect.url);
    } catch {
      return deny("host-outside-grant", "Fetch destination is not a URL");
    }
    const structural = urlRefusal(parsed);
    if (structural !== undefined) return deny("host-outside-grant", structural);
    const pinned = egressHostRefusal(parsed, grant.networkMode, grant.allowedHosts);
    if (pinned !== undefined) return deny("host-outside-grant", pinned);
    return undefined;
  }
  const pinned = hostRefusal(effect.url, grant.allowedHosts);
  if (pinned !== undefined) return deny("host-outside-grant", pinned);
  return undefined;
}

/**
 * The refusal a denial becomes. Exhaustive over `ROUTINE_GRANT_DENIALS`, so a
 * new code cannot silently inherit an unrelated message, and the resolution's
 * own detail travels with it.
 */
export function routineGrantRefusal(resolution: GrantDenial): TaviError {
  const messages: Record<RoutineGrantDenial, string> = {
    "grant-absent": "Routine run has no durable grant",
    "grant-mismatch": "Routine grant identity does not match this run",
    "grant-scope-mismatch": "Routine grant scope mismatch",
    "grant-revoked": "Routine grant is revoked",
    "authority-withdrawn": "Current workspace or tool authority no longer covers this run",
    "tool-outside-grant": "Tool is outside the research grant",
    "host-outside-grant": "Host is outside the research grant",
    "destination-outside-grant": "Destination is outside the research grant",
  };
  return new TaviError("NOT_AUTHORIZED", messages[resolution.code], {
    details: { reason: resolution.code, denial: resolution.code, detail: resolution.detail },
  });
}

/**
 * The ledger event a refused effect records: the pinned grant's identity, and
 * as evidence the refused effect's own — a stale claim, the URL or destination
 * it tried.
 */
export function routineGrantDenyEvent(
  run: RoutineRun,
  generation: number,
  step: RoutineStep,
  resolution: GrantDenial,
  effect?: RoutineGrantEffect,
): { readonly envelope: RoutineEnvelope; readonly detail: { kind: "evidence"; text: string } } {
  const claimed =
    effect !== undefined && "grantId" in effect && effect.grantId != null && effect.grantId !== run.grantId ? effect.grantId : undefined;
  return {
    envelope: {
      version: 1,
      code: "grant",
      step,
      generation,
      decision: "deny",
      denial: resolution.code,
      ...(run.grantId === null ? {} : { grantId: run.grantId }),
      ...(effect?.tool === undefined ? {} : { tool: effect.tool }),
    },
    detail: {
      kind: "evidence",
      text: canonicalRoutineJson({
        denial: resolution.code,
        detail: resolution.detail,
        ...(claimed === undefined ? {} : { claimedGrantId: claimed }),
        ...(effect?.url === undefined ? {} : { attemptedUrl: effect.url }),
        ...(effect?.destinationId === undefined ? {} : { attemptedDestinationId: effect.destinationId }),
      }),
    },
  };
}

/** The grant fields every allowed effect records, so the ledger shows what authorized it. */
export function routineGrantDecisionFields(
  db: RoutineDatabase,
  run: RoutineRun,
): { grantId?: string; policyRevision?: number; decision: "allow" } {
  const row = run.grantId === null ? undefined : grantRow(db, run.runId);
  return {
    decision: "allow",
    ...(run.grantId === null ? {} : { grantId: run.grantId }),
    ...(row === undefined || row.grant_id !== run.grantId ? {} : { policyRevision: row.policy_revision }),
  };
}

/**
 * The pinned grant for a run, as persisted, or `null` when the run has none.
 *
 * Absence is a state, not an error: a run admitted before routine grants
 * existed has `grant_id IS NULL`, and the operator must still be able to read
 * the run and its ceilings. A grant that is *present* but does not
 * survive the same checks the enforcement path applies is a different matter:
 * it is refused with a typed `UNAVAILABLE` rather than thrown as a parse error,
 * so the inspector can never render a revision the next effect would refuse.
 */
export function readRoutineGrant(
  db: RoutineDatabase,
  run: RoutineRun,
): (RoutineGrant & { readonly revokedAt: string | null; readonly revokedReason: string | null }) | null {
  const loaded = loadGrant(db, run);
  if ("denial" in loaded) {
    if (loaded.denial === "grant-absent") return null;
    throw new TaviError("UNAVAILABLE", `Routine grant is not readable: ${loaded.detail}`, {
      details: { reason: loaded.denial, denial: loaded.denial, detail: loaded.detail },
    });
  }
  const { grant, row } = loaded;
  return { ...grant, revokedAt: row.revoked_at, revokedReason: row.revoked_reason };
}

/**
 * The grant intersected with the run's pinned snapshot policy: what the
 * operator actually gets. The tool list is filtered to the set the research
 * adapter would actually hand the model, so the inspector can never display a
 * tool the grant cannot allow.
 */
export function routineGrantView(
  run: RoutineRun,
  grant: RoutineGrant & { readonly revokedAt: string | null; readonly revokedReason: string | null },
  pluginReads: readonly string[],
): RoutineGrantView {
  const research = routineGrantableTools("research", grant, run.snapshot, pluginReads);
  const currentHosts = new Set(run.snapshot.permissions.allowedHosts);
  return {
    grantId: grant.grantId,
    policyRevision: grant.policyRevision,
    revision: grant.revision,
    mode: grant.mode,
    networkMode: grant.networkMode,
    researchTools: research,
    allowedHosts: grant.allowedHosts.filter((host) => currentHosts.has(host)),
    destinationIds: grant.destinationIds.filter((id) => run.snapshot.delivery.targetIds.includes(id)),
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
    revokedReason: grant.revokedReason,
    narrowedTools: grant.researchTools.filter((tool) => !research.includes(tool)),
    ...(grant.primarySourcePolicyVersion === undefined ? {} : { primarySourcePolicyVersion: grant.primarySourcePolicyVersion }),
  };
}

export type RoutineEffectPort = Pick<
  RoutineExecutionService,
  | "append"
  | "assertFence"
  | "beginStep"
  | "heartbeat"
  | "knownRetired"
  | "recordEgressDenial"
  | "recordRetirement"
  | "remainingMs"
  | "reserveControlTool"
  | "reserveModel"
  | "reserveTool"
  | "settleModel"
  | "options"
  | "skillContext"
>;

/** Each fallback provider invocation enters this wrapper separately. Unknown usage retains its reservation. */
export function routineModelPort(
  models: ModelPort,
  runs: RoutineEffectPort,
  run: RoutineRun,
  fence: RoutineFence,
  role: "research" | "synthesis",
  deferStepStart = false,
): ModelPort {
  // Captured when the worker adapter is built. Note what this is and is not: the
  // routine loop builds the adapter from a fresh read of the run, so the claim
  // always equals the pinned identity in production — the claim exists to catch a
  // caller (a reused or replayed adapter) that hands over a `RoutineRun` snapshot
  // from another run, and `assertFence` independently rejects a stale generation.
  // The load-bearing part is that the grant is *re-read from storage* on every call.
  const claimedGrantId = run.grantId;
  const port: ModelPort = {
    async stream(request, options) {
      const context = { workspaceId: run.workspaceId, principalId: run.principalId, runId: request.runId, caller: "routine" };
      let binding: import("@tavi/contracts").ProviderBindingReference | undefined;
      try {
        binding = await models.resolveBinding?.(request, context);
      } catch (error) {
        if (!(error instanceof TaviError) || error.code !== "UNAVAILABLE") throw error;
        return {
          attemptId: request.attemptId,
          status: "failed",
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "model_unavailable", message: "Pinned provider is unavailable", retryable: false },
        };
      }
      const policy = run.snapshot.models[role];
      const target = [policy.primary, ...policy.fallbacks].find(
        (target) => target.connectionId === request.connectionId && target.model === request.model,
      );
      if (binding !== undefined && target?.bindingHash !== binding.bindingHash)
        throw new TaviError("NOT_AUTHORIZED", "Routine model binding changed since its revision was approved");
      await runs.skillContext({ workspaceId: run.workspaceId, principalId: run.principalId }, run.snapshot.skills);
      // One grant evaluation per provider call: the fence carries the identity claim.
      await runs.assertFence(fence, role, true, { grantId: claimedGrantId });
      if (await runs.knownRetired(run.routineId, request))
        return {
          attemptId: request.attemptId,
          status: "failed",
          text: "",
          toolCalls: [],
          usage: { totalTokens: 0 },
          error: { code: "model_retired", message: "Pinned model has a recorded retirement", retryable: false },
        };
      if (!deferStepStart) await runs.beginStep(fence, role);
      await runs.heartbeat(fence);
      const maximumOutput = Math.min(request.maxOutputTokens ?? 4096, 8192);
      // Conservative transport-byte estimate plus protocol framing, shown as a reservation, not measured usage.
      const reservation = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) + 16_384 + maximumOutput;
      await runs.reserveModel(fence, role, request.attemptId, reservation, {
        ...request,
        ...(binding === undefined
          ? {}
          : {
              bindingHash: binding.bindingHash,
              operation: providerOperation(binding, context, request.attemptId, request.purpose ?? "generation", {
                accountingRef: request.attemptId,
              }),
            }),
      });
      for (const message of request.messages.filter((message) => message.role === "system"))
        await runs.append(
          run,
          { version: 1, code: "model", step: role, generation: fence.generation, connectionId: request.connectionId, model: request.model },
          fence.attemptId,
          { kind: "prompt", text: message.text },
        );
      const remaining = await runs.remainingMs(fence, role);
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, remaining))]);
      let settled = false;
      try {
        const result = await models.stream(
          { ...request, maxOutputTokens: maximumOutput },
          { ...options, signal, context, ...(binding === undefined ? {} : { expectedBindingHash: binding.bindingHash }) },
        );
        await runs.assertFence(fence, role);
        if (role === "synthesis") for (const call of result.toolCalls) await runs.reserveControlTool(fence, call.name);
        const usage =
          result.usage.totalTokens ??
          (result.usage.inputTokens === undefined || result.usage.outputTokens === undefined
            ? undefined
            : result.usage.inputTokens + result.usage.outputTokens);
        await runs.settleModel(fence, request.attemptId, usage);
        settled = true;
        if (result.error?.code === "model_retired") await runs.recordRetirement(fence, role, request);
        return result;
      } finally {
        if (!settled) {
          // Retain the reservation if the provider threw or the owner lost its lease.
          try {
            await runs.settleModel(fence, request.attemptId);
          } catch {
            /* fenced: the next attempt inherits the reservation */
          }
        }
      }
    },
  };
  return port;
}

/** Immutable, step-scoped view; neither model-selected tools nor approvals can enlarge it. */
export function routineResearchTools(
  tools: ToolRegistryPort,
  runs: RoutineEffectPort,
  run: RoutineRun,
  fence: RoutineFence,
  capture?: (tool: string, input: unknown, output: unknown, origin?: "plugin") => unknown,
): ToolRegistryPort {
  const httpSchema = z.strictObject({ url: z.string().url().max(2048), method: z.literal("GET").optional() });
  const httpJsonSchema = z.toJSONSchema(httpSchema);
  // `web_fetch` takes a URL and nothing else: no method, no headers, no body, so
  // there is no field through which a caller could smuggle a credential.
  const fetchSchema = z.strictObject({ url: z.string().url().max(2048) });
  const fetchJsonSchema = z.toJSONSchema(fetchSchema);
  const networkMode = run.snapshot.permissions.networkMode;
  // Two independent upper bounds: this module's own tool allowlist, and the run's
  // persisted grant. Neither can enlarge the other — and both derive the
  // allowlist itself from `routineGrantableToolIds`, so a tool cannot be offered
  // here and refused there.
  const pluginReads = routinePluginReads(tools);
  const grantable = routineGrantableToolIds(networkMode, pluginReads);
  // A plugin read's result is evidence by its own `routineSources`: the capture is told which tools are plugin reads, by the registry, never by a name.
  const originOf = (id: string): "plugin" | undefined => (pluginReads.includes(id) ? "plugin" : undefined);
  const allowed = new Set(run.snapshot.permissions.researchTools.filter((id) => grantable.includes(id)));
  const claimedGrantId = run.grantId;
  // Under `open_web`, `web_fetch` reaches only pages this run was shown: a URL
  // its own `web_search` returned, or where a page it fetched redirected. A
  // fetched page can instruct the model, and a URL the model composes — with
  // what it has read folded into the path or query — is how that instruction
  // would carry the run's material to a host of the page's choosing. The set
  // lives with the run's tools, so a recovered run searches again.
  // Matched by the shared known-URL rule (`@tavi/contracts` known-url):
  // exact after normalization, the query byte for byte.
  const discovered = new Set<string>();
  const remember = (id: string, result: unknown): void => {
    const add = (value: unknown): void => {
      const key = typeof value === "string" ? normalizeUrl(value) : undefined;
      if (key !== undefined) discovered.add(key);
    };
    if (id === "web_search")
      for (const source of (result as { sources?: readonly { url?: unknown }[] } | undefined)?.sources ?? []) add(source.url);
    if (id === "web_fetch") {
      const fetched = result as { content?: { url?: unknown }; receipt?: { finalUrl?: unknown } } | undefined;
      add(fetched?.content?.url);
      add(fetched?.receipt?.finalUrl);
    }
  };
  return {
    register() {
      throw new TaviError("NOT_AUTHORIZED", "Routine tool grants are immutable");
    },
    // A routine's `web_fetch` runs under the revision's own egress policy, not
    // the operator's `--http-allow-host` list that the generic offer and
    // assessor read: neither applies here.
    list: () => tools.list().filter((tool) => allowed.has(tool.id)),
    listOffered: async (context) => {
      const offered = new Set((await tools.listOffered(context)).map((tool) => tool.id));
      return tools.list().filter((tool) => allowed.has(tool.id) && (offered.has(tool.id) || tool.id === "web_fetch"));
    },
    get(id) {
      if (!allowed.has(id)) return undefined;
      const registered = tools.get(id);
      if (registered === undefined) return undefined;
      const { assess: _assess, ...unassessed } = registered;
      // `web_fetch`'s served assessor reads the operator's host list, which is not the routine's: its URL is
      // all the gate is told, so the known-URL rule can judge it under taint.
      const tool =
        id === "web_fetch"
          ? {
              ...unassessed,
              assess: (input: unknown) => {
                const url = (input as { readonly url?: unknown } | null)?.url;
                return {
                  display: { title: `Fetch ${String(url)}`.slice(0, 300) },
                  subjects: [],
                  risk: "low" as const,
                  reasons: [],
                  ...(typeof url === "string" ? { urls: [url] } : {}),
                };
              },
            }
          : registered;
      const fetchOptions = { networkMode, allowedHosts: run.snapshot.permissions.allowedHosts, ...runs.options.publicFetch };
      const dispatchedFetch = () => {
        const execution = fetchOptions.execution;
        if (execution === undefined) throw new TaviError("UNAVAILABLE", "Fetch execution boundary is unavailable");
        return { ...fetchOptions, execution };
      };
      const resolveBinding =
        id === "web_fetch"
          ? async (input: unknown, context: import("@tavi/contracts").InvocationContext) =>
              resolveFetchBinding(dispatchedFetch(), input, context)
          : tool.resolveBinding;
      return {
        ...tool,
        ...(resolveBinding === undefined ? {} : { resolveBinding }),
        ...(id === "http.request"
          ? {
              inputSchema: httpSchema,
              inputJsonSchema: httpJsonSchema,
              description: "Fetch a public HTTPS page from an approved host with GET. No credentials, headers, body, or redirects.",
            }
          : {}),
        ...(id === "web_fetch"
          ? {
              inputSchema: fetchSchema,
              inputJsonSchema: fetchJsonSchema,
              description: `Retrieve one public HTTPS page under this revision's ${networkMode} egress policy. No credentials, cookies or custom headers; private, loopback and metadata addresses are refused on every hop, redirects are re-checked, and the response is bounded. Retrieval is not verification.`,
            }
          : {}),
        async handler(call) {
          if (call.context.workspaceId !== run.workspaceId || call.context.principalId !== run.principalId)
            throw new TaviError("NOT_AUTHORIZED", "Routine tool scope mismatch");
          const input = call.input as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
          if (
            id === "http.request" &&
            (Object.keys(input).some((key) => !["url", "method"].includes(key)) ||
              typeof input.url !== "string" ||
              (input.method !== undefined && input.method !== "GET") ||
              input.headers !== undefined ||
              input.body !== undefined)
          )
            throw new TaviError("NOT_AUTHORIZED", "Routine research fetch permits only public GET requests");
          const url = typeof input.url === "string" ? input.url : undefined;
          const binding = await resolveBinding?.(call.input, call.context);
          if (binding !== undefined && binding.bindingHash !== call.expectedBindingHash)
            throw new TaviError("NOT_AUTHORIZED", "Routine provider changed since authorization");
          const pinned = run.snapshot.permissions.providerBindings?.[id];
          const generation = id === "web_fetch" ? await fetchOptions.bindingGeneration?.(call.context) : binding?.bindingHash;
          if (binding !== undefined && generation !== undefined && pinned !== generation)
            throw new TaviError("NOT_AUTHORIZED", "Routine provider binding changed since its revision was approved");
          // After the binding checks (a changed provider is the more specific
          // refusal) and before any effect is reserved.
          if (id === "web_fetch" && networkMode === "open_web" && (url === undefined || !isKnownUrl(url, discovered))) {
            const message = "An open-web fetch is limited to pages this run's searches returned; search for the page first";
            if (url !== undefined) await runs.recordEgressDenial(fence, "research", id, url, message);
            throw new TaviError("NOT_AUTHORIZED", message);
          }
          const reserveProviderAttempt = async (operation: import("@tavi/contracts").ProviderOperation) => {
            if (
              id === "web_fetch" &&
              fetchOptions.bindingGeneration !== undefined &&
              (await fetchOptions.bindingGeneration(call.context)) !== generation
            )
              throw new TaviError("NOT_AUTHORIZED", "Routine fetch selection changed before dispatch");
            await runs.reserveTool(fence, id, url, {
              grantId: claimedGrantId,
              ...(generation === undefined ? {} : { bindingHash: generation }),
              operation,
            });
          };
          await runs.beginStep(fence, "research");
          // `reserveTool` resolves the grant immediately before the effect — a stale
          // claim, a revoked grant, or a host outside either bound refuses before the
          // request is made — and applies the same host predicate the HTTP tool uses.
          if (binding === undefined) await runs.reserveTool(fence, id, url, { grantId: claimedGrantId });
          const signal = AbortSignal.any([call.signal, AbortSignal.timeout(await runs.remainingMs(fence, "research"))]);
          let result: unknown;
          try {
            // The run's pinned policy is bound here, not read from the registry's
            // generic defaults: a routine's egress is a property of its revision.
            //
            // The allowlist `http.request` consults is a *name* list, so the
            // address classification is applied here too, immediately before the
            // call: a refusal is a grant decision for the run. The tool itself then
            // dials through `pinnedFetch`, which resolves again, refuses a
            // non-public answer and pins the socket to the address it checked.
            if (id === "http.request" && url !== undefined) {
              try {
                await assertPublicDestination(runs, url);
              } catch (error) {
                // Only a typed authority refusal is a grant decision. A resolver
                // failure is an availability problem, and recording it as
                // `host-outside-grant` would put "the destination is outside what the
                // grant can reach" in the durable ledger for a name the grant allows;
                // it propagates unrecorded instead.
                if (error instanceof TaviError && error.code === "NOT_AUTHORIZED")
                  await runs.recordEgressDenial(fence, "research", id, url, error.message);
                throw error;
              }
            }
            result =
              id === "web_fetch"
                ? await boundPublicFetch(
                    dispatchedFetch(),
                    call.input,
                    call.context,
                    signal,
                    binding?.bindingHash,
                    reserveProviderAttempt,
                    call.operationEnvelope,
                  )
                : await tool.handler({ ...call, signal, reserveProviderAttempt });
          } catch (error) {
            await runs.assertFence(fence, "research");
            // The failed call is recorded when it can be. Recording is awaited and
            // its own failure contained: a URL evidence cannot hold (not HTTPS, not
            // a URL at all — the model chooses it) must not become an unhandled
            // rejection, which would end the owner process. The call's own error
            // is what the model sees.
            if (capture !== undefined) {
              try {
                await capture(id, call.input, { ok: false }, originOf(id));
              } catch {
                /* unrecordable: the original error below still reports the refusal */
              }
            }
            throw error;
          }
          await runs.assertFence(fence, "research");
          remember(id, result);
          return capture === undefined ? result : capture(id, call.input, result, originOf(id));
        },
      };
    },
    inputSchemaOf: (id) => (allowed.has(id) ? (id === "http.request" ? httpSchema : tools.inputSchemaOf(id)) : undefined),
    inputJsonSchemaOf: (id) => (allowed.has(id) ? (id === "http.request" ? httpJsonSchema : tools.inputJsonSchemaOf(id)) : undefined),
    modelNameOf: (id) => (allowed.has(id) ? tools.modelNameOf(id) : undefined),
    resolveModelName(name) {
      const id = tools.resolveModelName(name);
      return id !== undefined && allowed.has(id) ? id : undefined;
    },
  };
}
