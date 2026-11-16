import {
  CHAT_NOTES_KEY_PREFIX,
  TaviError,
  memoryScopeKey,
  operatorSeesChatNote,
  operatorSeesMemory,
  type AccessPolicyPort,
  type MemoryActor,
  type MemoryRecord,
  type MemoryScope,
} from "@tavi/contracts";

/**
 * Who may read and write which memory: the scopes an actor's reads cover, the
 * check a named scope passes, and the operator's authority and view. Every
 * read is scoped by the actor, never by the request.
 */

/** The permission that makes a `shared_workspace` scope readable. */
export const MEMORY_READ_SHARED_PERMISSION = "memory:read-shared";

/** Whether a read keeps this record: one asked to leave out local chats' records keeps none of them. */
export function keepsOrigin(input: { readonly excludeLocalOrigin?: boolean }, record: MemoryRecord): boolean {
  return input.excludeLocalOrigin !== true || record.localOrigin !== true;
}

/** Whether `actor` holds the reader grant for its workspace's shared scope. */
function hasSharedReadGrant(policy: AccessPolicyPort | undefined, actor: MemoryActor): boolean {
  if (policy === undefined) return false;
  const missing = policy.missingPermissions(
    { workspaceId: actor.workspaceId, principalId: actor.principalId, runId: actor.runId ?? "", caller: actor.caller },
    [MEMORY_READ_SHARED_PERMISSION],
  );
  return missing.length === 0;
}

/**
 * The scope keys this actor may read, in precedence order.
 *
 * `actor.scopeRestricted` (a delegated worker's admitted context —
 * `InvocationContext.memoryScopeRestricted`, threaded through
 * `buildSystemPromptText`) omits `personal`/
 * `personal_workspace`/`personal_agent`: a worker's own principal/
 * workspace/agent identity is inherited from its orchestrator
 * (`spawn()` never mints a new principal), so granting those scopes
 * unrestricted would make a worker's memory access byte-identical to
 * its orchestrator's — the gap this restriction closes. `run_local`
 * stays available (it was never the leak: it is scoped to the
 * worker's own task, not shared with the orchestrator) and so does
 * `shared_workspace` (a workspace-wide grant is a workspace decision,
 * not a personal-memory leak — narrowing it is not this
 * restriction's job). `actor.chatTaskId` adds its chat's notes
 * alone, as a `CHAT_NOTES_KEY_PREFIX` key, and
 * `actor.parentChatId` a side chat's parent's.
 * `actor.reach === "chat-only"` (a group conversation)
 * keeps only those chat scopes: no personal, persona or shared scope, so
 * no personal preference either.
 */
export function authorizedScopeKeys(policy: AccessPolicyPort | undefined, actor: MemoryActor): readonly string[] {
  const scopes: MemoryScope[] = [
    { kind: "run_local", principalId: actor.principalId, workspaceId: actor.workspaceId, runId: actor.runId ?? "" },
  ];
  const chatOnly = actor.reach === "chat-only";
  if (actor.scopeRestricted !== true && !chatOnly) {
    scopes.push(
      { kind: "personal", principalId: actor.principalId },
      { kind: "personal_workspace", principalId: actor.principalId, workspaceId: actor.workspaceId },
    );
  }
  // The shared scope is a workspace resource, but membership alone does not
  // make it readable: an explicit reader grant does, never a silent
  // broadening of personal scope. It is read-only here
  // either way — writing it is an explicit share.
  if (!chatOnly && hasSharedReadGrant(policy, actor)) {
    scopes.push({ kind: "shared_workspace", workspaceId: actor.workspaceId });
  }
  if (actor.agentId !== undefined && actor.scopeRestricted !== true && !chatOnly) {
    scopes.push({ kind: "personal_agent", principalId: actor.principalId, agentId: actor.agentId });
    scopes.push({
      kind: "personal_agent",
      principalId: actor.principalId,
      agentId: actor.agentId,
      workspaceId: actor.workspaceId,
    });
  }
  const keys = scopes
    // A run-local scope without a run id would be a wildcard, so it is omitted.
    .filter((scope) => scope.kind !== "run_local" || scope.runId !== "")
    .map(memoryScopeKey);
  // A delegated task reads its chat's notes, and only those.
  if (actor.chatTaskId !== undefined && actor.chatTaskId !== "" && actor.chatTaskId !== actor.runId) {
    keys.push(
      `${CHAT_NOTES_KEY_PREFIX}${memoryScopeKey({ kind: "run_local", principalId: actor.principalId, workspaceId: actor.workspaceId, runId: actor.chatTaskId })}`,
    );
  }
  // A side chat reads its parent's notes too, and only those.
  if (
    actor.parentChatId !== undefined &&
    actor.parentChatId !== "" &&
    actor.parentChatId !== actor.runId &&
    actor.parentChatId !== actor.chatTaskId
  ) {
    keys.push(
      `${CHAT_NOTES_KEY_PREFIX}${memoryScopeKey({ kind: "run_local", principalId: actor.principalId, workspaceId: actor.workspaceId, runId: actor.parentChatId })}`,
    );
  }
  return keys;
}

export function authorizeScope(
  policy: AccessPolicyPort | undefined,
  actor: MemoryActor,
  scope: MemoryScope,
  mode: "read" | "write",
): MemoryScope {
  // A group conversation reads and writes only its chat's notes.
  if (actor.reach === "chat-only" && scope.kind !== "run_local") {
    throw new TaviError("NOT_AUTHORIZED", "Memory isn't used in group chats: only this chat's notes are");
  }
  switch (scope.kind) {
    case "personal":
    case "personal_workspace":
    case "personal_agent":
      if (scope.principalId !== actor.principalId) {
        throw new TaviError("NOT_AUTHORIZED", "Another principal's memory requires an explicit share");
      }
      if ("workspaceId" in scope && scope.workspaceId !== undefined && scope.workspaceId !== actor.workspaceId) {
        throw new TaviError("NOT_AUTHORIZED", "That workspace is not the one this invocation acts in");
      }
      if (scope.kind === "personal_agent" && scope.agentId !== actor.agentId) {
        throw new TaviError("NOT_AUTHORIZED", "That agent scope is not the one this invocation acts as");
      }
      return scope;
    case "run_local":
      if (scope.principalId !== actor.principalId || scope.workspaceId !== actor.workspaceId || scope.runId !== actor.runId) {
        throw new TaviError("NOT_AUTHORIZED", "Run-local memory belongs to the run that created it");
      }
      return scope;
    case "shared_workspace":
      if (scope.workspaceId !== actor.workspaceId) {
        throw new TaviError("NOT_AUTHORIZED", "That workspace is not the one this invocation acts in");
      }
      if (mode === "write") {
        // Publishing into the shared scope is an explicit share with recorded
        // provenance, never a silent broadening of a personal scope.
        throw new TaviError("NOT_AUTHORIZED", "Shared workspace memory is published by an explicit share, not by writing into it");
      }
      if (!hasSharedReadGrant(policy, actor)) {
        throw new TaviError("NOT_AUTHORIZED", "Reading shared workspace memory requires an explicit reader grant");
      }
      return scope;
  }
}

/**
 * The scope keys a read call should query: every authorized scope when the
 * caller left `scope` unspecified, or the one explicit scope once it has
 * passed authorization — the same choice `list`, `search` and `export`
 * each made independently before this was extracted, which risked one of
 * them forgetting to authorize an explicit scope.
 */
export function readScopeKeys(policy: AccessPolicyPort | undefined, actor: MemoryActor, scope: MemoryScope | undefined): readonly string[] {
  return scope === undefined ? authorizedScopeKeys(policy, actor) : [memoryScopeKey(authorizeScope(policy, actor, scope, "read"))];
}

/**
 * A model can suggest a fact/preference/lesson but cannot approve, correct,
 * revoke or forget it (stated most plainly of everything in this
 * layer): those five operations require `authority: "operator"`.
 */
export function requireOperator(actor: MemoryActor, operation: string): void {
  if (actor.authority !== "operator") {
    throw new TaviError("NOT_AUTHORIZED", `A model cannot ${operation} memory; that requires operator authority`);
  }
}

/**
 * The operator's page and its counts span every scope the operator sees, so
 * an operator actor carrying a restriction (`reach`, `scopeRestricted`,
 * `allowedRecordIds`) cannot read them: those fields bound it on the
 * ordinary path (`#authorizedScopeKeys`).
 */
export function requireOperatorView(actor: MemoryActor, operation: string): void {
  requireOperator(actor, operation);
  if (actor.reach !== undefined || actor.scopeRestricted === true || actor.allowedRecordIds !== undefined) {
    throw new TaviError("NOT_AUTHORIZED", `A restricted actor cannot ${operation} memory`);
  }
}

export function operatorSees(actor: MemoryActor, record: MemoryRecord): boolean {
  const operator = { principalId: actor.principalId, workspaceId: actor.workspaceId };
  return operatorSeesMemory(record.scope, operator) || operatorSeesChatNote(record, operator);
}
