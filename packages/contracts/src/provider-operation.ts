import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ProviderBindingSchema = z.strictObject({
  kind: z.enum(["search", "fetch", "model"]),
  instanceId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(128),
  principalId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  implementationHash: hash,
  configRevision: hash,
  endpoint: z.union([
    z.literal("in-process"),
    z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .refine(
        (value) => /^https?:\/\/[^/?#@\\]+(?:\/[^?#\\]*)?$/.test(value),
        "binding endpoint cannot carry credentials, query parameters or a fragment",
      ),
  ]),
});
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

/**
 * What the caller knows about an operation beyond its binding: the task, the
 * gate verdict that allowed it, whether the conversation was tainted, and the
 * row that accounts for it (a tool call ID, a model call ID or a routine
 * reservation ID). Optional, so rows written before these fields still parse.
 */
export const ProviderOperationEnvelopeSchema = z.strictObject({
  taskId: z.string().min(1).max(128).optional(),
  ruleId: z.string().min(1).max(128).optional(),
  tainted: z.boolean().optional(),
  accountingRef: z.string().min(1).max(256).optional(),
});
export type ProviderOperationEnvelope = z.infer<typeof ProviderOperationEnvelopeSchema>;

/** Host metadata stored beside provider payloads, never sent to a provider. */
export const ProviderOperationSchema = z.strictObject({
  version: z.literal(1),
  binding: ProviderBindingSchema,
  bindingHash: hash,
  runId: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128),
  purpose: z.string().min(1).max(64),
  caller: z.string().min(1).max(128),
  ...ProviderOperationEnvelopeSchema.shape,
});
export type ProviderOperation = z.infer<typeof ProviderOperationSchema>;

export interface ProviderBindingReference {
  readonly binding: ProviderBinding;
  readonly bindingHash: string;
}

export const ProviderOperationRecordSchema = z.strictObject({
  operation: ProviderOperationSchema,
  ownerSession: z.string().min(1).max(128),
  state: z.enum(["started", "completed", "uncertain"]),
});
export type ProviderOperationRecord = z.infer<typeof ProviderOperationRecordSchema>;
export interface ProviderOperationsPort {
  reserveOperation(operation: ProviderOperation, ownerSession: string): Promise<void>;
  finishOperation(runId: string, attemptId: string, state: "completed" | "uncertain"): Promise<void>;
  operations(runId: string): Promise<readonly ProviderOperationRecord[]>;
}
