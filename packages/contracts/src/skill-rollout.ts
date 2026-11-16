import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * A skill version's bounded rollout: an explicit small set of authorized
 * tasks. `SkillActivation` is a per-workspace pointer with no task-scoping
 * field, so on its own an activated version is live for every task in its
 * workspace. This module is the additional scoping layer, built as an opt-in
 * overlay rather than a change to `SkillActivation`'s own CAS semantics.
 *
 * Insert-only: one row per
 * `(scopeKey, skillId, version, taskId)` explicitly authorized to see
 * this version during its bounded rollout window. **Absence of ANY row
 * for a given `(scopeKey, skillId, version)` triple means unrestricted
 * — every task may use it** (the pre-existing, unrestricted default
 * behavior every activated version has). A rollout only becomes
 * bounded once at least one row exists for that triple; from that
 * moment on, only listed `taskId`s may see this specific version. This
 * makes pinning purely opt-in: an activation nobody ever calls
 * `pinRollout` for is unrestricted.
 */
export const SkillRolloutAllowlistEntrySchema = z.object({
  entryId: IdSchema,
  scopeKey: z.string().min(1).max(256),
  skillId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  taskId: IdSchema,
  authorizedBy: IdSchema,
  authorizedAt: TimestampSchema,
});
export type SkillRolloutAllowlistEntry = z.infer<typeof SkillRolloutAllowlistEntrySchema>;
