import { z } from "zod";

import type { AsyncRepository } from "./persistence-types.js";
import { ToolPatternSchema } from "./tool-policy.js";

/**
 * Room and contact grants: an operator's word on one tool in one room, or
 * in one person's
 * one-to-one chat, on a connection. `deny` narrows any scope. `allow` lifts a
 * tool the messaging profile holds back, only for a contact in their
 * one-to-one chat, where it is then asked about as anywhere else: a room is
 * never granted more than the profile allows.
 */

export const GRANT_SCOPE_KINDS = ["room", "contact"] as const;
export type GrantScopeKind = (typeof GRANT_SCOPE_KINDS)[number];
export const GRANT_MODES = ["allow", "deny"] as const;
export type GrantMode = (typeof GRANT_MODES)[number];

/** The tools no room may ever be granted: what runs code or writes files. */
export const NEVER_IN_A_ROOM: readonly string[] = ["sandbox.run", "fs.write", "fs.edit"];

export const MessagingGrantRecordSchema = z.strictObject({
  grantId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(256),
  scopeKind: z.enum(GRANT_SCOPE_KINDS),
  /** The room's conversation id, or the contact's sender id, as the connection names them. */
  scopeId: z.string().min(1).max(256),
  toolId: ToolPatternSchema,
  mode: z.enum(GRANT_MODES),
  createdBy: z.string().min(1).max(128),
  createdAt: z.string().min(1).max(64),
  /** After this, it is as if it were not there. */
  expiresAt: z.string().min(1).max(64).optional(),
  revokedAt: z.string().min(1).max(64).optional(),
});
export type MessagingGrantRecord = z.infer<typeof MessagingGrantRecordSchema>;

/** Why a grant may not be saved, or nothing when it may: a room is only ever denied tools. */
export function grantRefusal(grant: Pick<MessagingGrantRecord, "scopeKind" | "toolId" | "mode">): string | undefined {
  if (grant.scopeKind !== "room" || grant.mode !== "allow") return undefined;
  if (NEVER_IN_A_ROOM.includes(grant.toolId)) return `a room can never be allowed ${grant.toolId}: it runs code or writes files`;
  return "a room can only be denied tools: allow a tool for one person in their one-to-one chat (a contact grant)";
}

/** Whether a grant is in force at `at`: not revoked, and not expired. */
export function grantInForce(grant: Pick<MessagingGrantRecord, "revokedAt" | "expiresAt">, at: string): boolean {
  return grant.revokedAt === undefined && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > Date.parse(at));
}

interface MessagingGrantRepositoryPortDefinition {
  /** Saves a grant; one of the same connection, scope and tool is replaced (its revocation cleared). */
  put(grant: MessagingGrantRecord): void;
  get(grantId: string): MessagingGrantRecord | undefined;
  /** Revokes it from `at`; false when there is none, or it was revoked already. */
  revoke(grantId: string, at: string): boolean;
  /** A connection's grants, revoked and expired ones included, oldest first. */
  listForConnection(connectionId: string): readonly MessagingGrantRecord[];
  /** The grants of one scope on a connection, in force or not. */
  listForScope(connectionId: string, scopeKind: GrantScopeKind, scopeId: string): readonly MessagingGrantRecord[];
  /** Every grant of a connection, for its purge; answers how many went. */
  removeForConnection(connectionId: string): number;
}
export type MessagingGrantRepositoryPort = AsyncRepository<MessagingGrantRepositoryPortDefinition>;
