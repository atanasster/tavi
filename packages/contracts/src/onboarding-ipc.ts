import { z } from "zod";

import { IdSchema } from "./ids.js";
import {
  OnboardingEnvVariableSchema,
  OnboardingFlowSchema,
  OnboardingStatusSchema,
  OnboardingStepKindSchema,
  OnboardingSurfaceSchema,
  OnboardingVerifyRoleSchema,
} from "./onboarding.js";

/**
 * `onboarding`: one workspace's setup status,
 * the flow to walk, detection, verify, and onboarding's own marks. Operator
 * only: a channel-originated or worker connection is refused. Every
 * configuration write a step makes goes through its own command (`models`,
 * `credentials`, `channels`, …); this command writes only onboarding's tables,
 * except `connect-detected`, which runs those same services in the process
 * that saw the variable or the local server.
 */

const scope = { workspaceId: IdSchema.optional() } as const;
/** The surface whose order the answered status follows (the terminal walks `service`, the web does not); absent, the web's. */
const view = { ...scope, surface: OnboardingSurfaceSchema.optional() } as const;
const PresetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const OnboardingPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status"), ...view }),
  z.strictObject({ action: z.literal("flow"), ...scope, surface: OnboardingSurfaceSchema }),
  /** Which allowlisted env variables and local servers exist: names and counts, never values. */
  z.strictObject({ action: z.literal("detect"), ...scope }),
  /** Use a detected key or local server: one explicit owner action that stores it and adds the connection. */
  z.strictObject({
    action: z.literal("connect-detected"),
    ...scope,
    preset: PresetIdSchema,
    variable: OnboardingEnvVariableSchema.optional(),
  }),
  /**
   * A key the person typed on the canvas, stored as `tavi onboard`
   * stores one: the connection at the preset's endpoint (or this flow's own,
   * rebound), then the key, then discovery. `baseUrl` is Custom's alone. The
   * key is in this one request, never in an answer.
   */
  z.strictObject({
    action: z.literal("connect-key"),
    ...scope,
    preset: PresetIdSchema,
    key: z.string().trim().min(1).max(16_384),
    baseUrl: z.string().url().max(500).optional(),
  }),
  /**
   * Sign in from the canvas, and the address to open; `sign-in-status` reads
   * how it stands. OpenRouter calls back under the `tavi ui` origin
   * (`callbackOrigin`, loopback only) and its key is stored as a typed one.
   * ChatGPT takes no origin: the owner listens on a `127.0.0.1`
   * loopback of its own, as OpenAI requires, and stores the token record.
   */
  z.strictObject({
    action: z.literal("sign-in"),
    ...scope,
    preset: z.enum(["openrouter", "chatgpt"]),
    callbackOrigin: z.string().url().max(200).optional(),
  }),
  /**
   * A ChatGPT sign-in the terminal made itself: its token record, stored
   * as the connection's credential. Never answered back, never logged.
   */
  z.strictObject({
    action: z.literal("connect-signed-in"),
    ...scope,
    preset: z.literal("chatgpt"),
    credential: z.string().min(1).max(65_536),
  }),
  z.strictObject({
    action: z.literal("sign-in-status"),
    ...scope,
    state: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
  }),
  /**
   * Absent `role`: `main`, then `fast` when it is a different target. With
   * `target`, that connection and model are tested for `role` before they
   * become it, so a change is proven before it replaces what works.
   */
  z
    .strictObject({
      action: z.literal("verify"),
      ...scope,
      role: OnboardingVerifyRoleSchema.optional(),
      target: z.strictObject({ connectionId: IdSchema, model: z.string().min(1).max(256) }).optional(),
    })
    .refine((payload) => payload.target === undefined || payload.role !== undefined, {
      message: "a verify of a target names its role",
      path: ["role"],
    }),
  z.strictObject({ action: z.literal("skip"), ...view, step: OnboardingStepKindSchema }),
  /** A surface showed the step: the funnel's `reached`, counted once a visit. */
  z.strictObject({ action: z.literal("reached"), ...view, step: OnboardingStepKindSchema }),
  z.strictObject({ action: z.literal("restore"), ...view, step: OnboardingStepKindSchema }),
  z.strictObject({ action: z.literal("complete-step"), ...view, step: OnboardingStepKindSchema }),
  /**
   * What a step is about to create, recorded before its first write: a
   * connection id, search provider id or service label. A resumed run reuses
   * it, and it is the only thing the flow may rebind or overwrite.
   */
  z.strictObject({
    action: z.literal("created"),
    ...scope,
    step: z.enum(["model", "search", "service", "channels"]),
    ref: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
  }),
  /** "I run it myself". */
  z.strictObject({ action: z.literal("confirm-service"), ...view, mode: z.literal("self-managed") }),
  z.strictObject({ action: z.literal("dismiss"), ...view }),
  z.strictObject({ action: z.literal("complete"), ...view }),
  /** CLI only: refused through the `tavi ui` bridge. */
  z.strictObject({ action: z.literal("reset"), ...scope }),
  /** CLI only. Absent `id`: which flow runs, and the installed ones. */
  z.strictObject({ action: z.literal("provider"), id: z.string().min(1).max(128).optional() }),
]);
export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>;

// ------------------------------------------------------------------ answers

export const OnboardingStatusAnswerSchema = OnboardingStatusSchema;
export type OnboardingStatusAnswer = z.infer<typeof OnboardingStatusAnswerSchema>;

export const OnboardingFlowAnswerSchema = z.object({
  flow: OnboardingFlowSchema,
  providerId: z.string().min(1).max(128),
  /** Why the built-in flow was used instead of the selected provider's. */
  fallback: z.string().max(300).optional(),
});
export type OnboardingFlowAnswer = z.infer<typeof OnboardingFlowAnswerSchema>;

export const OnboardingDetectAnswerSchema = z.object({
  env: z.array(OnboardingEnvVariableSchema).readonly(),
  local: z
    .array(z.object({ preset: PresetIdSchema, models: z.number().int().nonnegative(), toolCapableModels: z.number().int().nonnegative() }))
    .readonly(),
  /** Model connections already configured. */
  existing: z.array(IdSchema).readonly(),
  /** The owner runs as a service, whose environment holds no shell variables. */
  service: z.boolean().optional(),
});
export type OnboardingDetectAnswer = z.infer<typeof OnboardingDetectAnswerSchema>;

/** The connection and its discovered models; never the key. */
export const OnboardingConnectAnswerSchema = z.object({
  connectionId: IdSchema,
  models: z.array(z.string().min(1).max(256)).readonly(),
  /** The `main` and `fast` models the host proposes from them; the person chooses. */
  suggested: z.object({ main: z.string().min(1).max(256).optional(), fast: z.string().min(1).max(256).optional() }).optional(),
});
export type OnboardingConnectAnswer = z.infer<typeof OnboardingConnectAnswerSchema>;

export const OnboardingVerifyResultSchema = z.object({
  role: OnboardingVerifyRoleSchema,
  connectionId: IdSchema,
  model: z.string().min(1).max(256),
  ok: z.boolean(),
  toolsOk: z.boolean().optional(),
  errorCode: z.string().min(1).max(64).optional(),
  /** Plain advice for a failure or a model that did not call the tool. */
  advice: z.string().max(400).optional(),
});
export type OnboardingVerifyResult = z.infer<typeof OnboardingVerifyResultSchema>;
export const OnboardingVerifyAnswerSchema = z.object({
  results: z.array(OnboardingVerifyResultSchema).readonly(),
  status: OnboardingStatusSchema,
});
export type OnboardingVerifyAnswer = z.infer<typeof OnboardingVerifyAnswerSchema>;

export const OnboardingProviderAnswerSchema = z.object({
  providerId: z.string().min(1).max(128).nullable(),
  providers: z
    .array(z.object({ id: z.string().min(1).max(128), kind: z.enum(["builtin", "plugin"]), disclosure: z.string().max(1_000).optional() }))
    .readonly(),
});
export type OnboardingProviderAnswer = z.infer<typeof OnboardingProviderAnswerSchema>;

export const OnboardingSignInAnswerSchema = z.object({ url: z.string().url().max(2048), state: z.string().min(16).max(128) });
export type OnboardingSignInAnswer = z.infer<typeof OnboardingSignInAnswerSchema>;
export const OnboardingSignInStatusAnswerSchema = z.object({
  state: z.enum(["waiting", "done", "failed", "gone"]),
  message: z.string().max(400).optional(),
  connectionId: IdSchema.optional(),
  /** Done: the connection the key was stored on, its models and the suggested roles, as `connect-key` answers. */
  connection: OnboardingConnectAnswerSchema.optional(),
});
export type OnboardingSignInStatusAnswer = z.infer<typeof OnboardingSignInStatusAnswerSchema>;

export const OnboardingResetAnswerSchema = z.object({ cleared: z.number().int().nonnegative() });
/** `reached`: counted, or the same visit's. */
export const OnboardingReachedAnswerSchema = z.object({ recorded: z.literal(true) });
export type OnboardingReachedAnswer = z.infer<typeof OnboardingReachedAnswerSchema>;
export type OnboardingResetAnswer = z.infer<typeof OnboardingResetAnswerSchema>;
