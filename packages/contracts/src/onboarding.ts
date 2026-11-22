import { z } from "zod";

import { IDEA_CAPABILITIES, IDEA_LABEL_MAX, IDEA_PROMPT_MAX, IdeaCapabilitySchema, plainTextSchema, type IdeaCapability } from "./ideas.js";
import type { Locale } from "./i18n.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import type { AsyncRepository } from "./persistence-types.js";
import { ContributionIdSchema } from "./plugin-ui.js";

/**
 * Onboarding: a declarative flow a
 * provider chooses, over a fixed host that derives every step's state from
 * live configuration. The store keeps only what live state cannot say — a
 * skip, a dismissal, a completed or self-managed step, what this flow created,
 * and verifications keyed to the credential revision they tested — never a
 * secret value.
 */

// ------------------------------------------------------------------ steps and status

export const ONBOARDING_STEP_KINDS = [
  "model",
  "about",
  "search",
  "apps",
  "tasks",
  "channels",
  "voice",
  "service",
  "ideas",
  "info",
] as const;
export type OnboardingStepKind = (typeof ONBOARDING_STEP_KINDS)[number];
export const OnboardingStepKindSchema = z.enum(ONBOARDING_STEP_KINDS);

/** Only the model blocks: every other step may be skipped. */
export const ONBOARDING_REQUIRED_STEPS: readonly OnboardingStepKind[] = ["model"];

export const ONBOARDING_STEP_STATES = ["done", "todo", "skipped", "blocked", "unavailable"] as const;
export type OnboardingStepState = (typeof ONBOARDING_STEP_STATES)[number];

export const ONBOARDING_SURFACES = ["cli", "web"] as const;
export type OnboardingSurface = (typeof ONBOARDING_SURFACES)[number];
export const OnboardingSurfaceSchema = z.enum(ONBOARDING_SURFACES);

/** The roles a model verification covers: `main` decides `done`, `fast` only warns. */
export const ONBOARDING_VERIFY_ROLES = ["main", "fast"] as const;
export type OnboardingVerifyRole = (typeof ONBOARDING_VERIFY_ROLES)[number];
export const OnboardingVerifyRoleSchema = z.enum(ONBOARDING_VERIFY_ROLES);

/** The longest a step's detail may be: the host cuts a longer one. */
export const ONBOARDING_STEP_DETAIL_MAX = 300;
const STEP_DETAIL_MAX = ONBOARDING_STEP_DETAIL_MAX;

export const ONBOARDING_TITLE_MAX = 80;

const DetailParamSchema = z.union([z.string().max(STEP_DETAIL_MAX), z.number()]);
const DetailKeySchema = z.string().min(1).max(128);
/**
 * A step's detail as a `core` key and its parameters, for a surface that
 * speaks another language; a parameter is data (a name, a model, joined
 * labels) or a message of its own (a verify's advice). Derived at read time,
 * never stored.
 */
export const OnboardingDetailTextSchema = z.object({
  key: DetailKeySchema,
  params: z
    .record(
      z.string().max(64),
      z.union([DetailParamSchema, z.object({ key: DetailKeySchema, params: z.record(z.string().max(64), DetailParamSchema).optional() })]),
    )
    .optional(),
});
export type OnboardingDetailText = z.infer<typeof OnboardingDetailTextSchema>;

export const OnboardingStepStatusSchema = z.object({
  kind: OnboardingStepKindSchema,
  state: z.enum(ONBOARDING_STEP_STATES),
  /** "OpenRouter · anthropic/claude-sonnet · verified 2 min ago": English, what a plugin granted `status-detail` and an older client read. */
  detail: z.string().max(STEP_DETAIL_MAX),
  /** `detail` as a key and its parameters, when it has words of its own: what a surface says in the workspace's language. */
  detailText: OnboardingDetailTextSchema.optional(),
  /** The model step's last successful verify on the current default target. */
  verifiedAt: TimestampSchema.optional(),
  /** `ideas` waits for `model`. */
  blockedBy: OnboardingStepKindSchema.optional(),
  /** The flow's title for the step: every surface names it the same. */
  title: z.string().min(1).max(ONBOARDING_TITLE_MAX).optional(),
  /**
   * Where the step is done when it is not done on the surface that asked
   * (`service` in a terminal, `apps` on the canvas): listed and counted there
   * too, with where to do it.
   */
  elsewhere: OnboardingSurfaceSchema.optional(),
  /** What this flow created for the step (a connection id, search provider id or service label): what a resumed run reuses. */
  createdRef: z.string().min(1).max(256).optional(),
  /** Apps, channels or task apps, one row each (a task app's id is its task home, `mcp:<server>`). */
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        label: z.string().min(1).max(120),
        state: z.enum(["connected", "available", "needs-sign-in"]),
      }),
    )
    .max(32)
    .readonly()
    .optional(),
});
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>;

export const OnboardingStatusSchema = z.object({
  workspaceId: IdSchema,
  /** The flow in use; null with `tavi.onboarding` disabled and no plugin, when the status still answers. */
  providerId: z.string().min(1).max(128).nullable(),
  steps: z.array(OnboardingStepStatusSchema).readonly(),
  /** Every required step is done. */
  complete: z.boolean(),
  /** The checklist card was dismissed (and not brought back by a newer flow version). */
  dismissedAt: TimestampSchema.optional(),
  /**
   * A dismissed card back once: the flow's version went up and these
   * open steps are new in it. The card shows only these; dismissing it again
   * is final until the next such version.
   */
  returning: z.array(OnboardingStepKindSchema).readonly().optional(),
  /** No model connection exists and no flow was ever finished or dismissed. */
  firstRun: z.boolean(),
  /** Sign in with ChatGPT is offered here (its preview is turned on); absent otherwise. */
  chatGptSignIn: z.boolean().optional(),
  /**
   * Setup's funnel on this machine: each step's reached, skipped and
   * failed counts and its last failure's code. Nothing of it leaves the
   * machine; `tavi onboard reset` clears it. Absent before any.
   */
  funnel: z
    .partialRecord(
      OnboardingStepKindSchema,
      z.strictObject({
        reached: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        lastError: z.string().max(64).optional(),
      }),
    )
    .optional(),
  /** When a flow was first finished (its done screen's *Go to Home*): Home promises the next morning's ideas after it. */
  completedAt: TimestampSchema.optional(),
  /** What `tavi onboard` and *Continue setup* walk: the steps that are neither done nor unavailable, in flow order. */
  open: z.array(OnboardingStepKindSchema).readonly(),
  /** Why the host fell back to the built-in flow, when it did. */
  flowFallback: z.string().max(STEP_DETAIL_MAX).optional(),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

// ------------------------------------------------------------------ the flow

/** The onboarding provider contract a plugin is built for; a change that would break one is a new ABI. */
export const ONBOARDING_ABI = "tavi.onboarding/1";

/** Each kind at most once: every kind's step, `info` among them. */
export const ONBOARDING_FLOW_STEPS_MAX = 10;
export const ONBOARDING_FEATURED_MAX = 4;
export const ONBOARDING_PROMPTS_MAX = 3;
export const ONBOARDING_BODY_MAX = 400;
/** How long the host waits for a provider's flow before it uses the built-in one. */
export const ONBOARDING_FLOW_DEADLINE_MS = 5_000;

const copy = (max: number, lines = false) => plainTextSchema(max, lines);

const FlowRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "a preset, channel kind or app id is a lower-case slug");

/** The id Welcome's closing screen is at (`/welcome/done`): no step may take it. */
export const ONBOARDING_DONE_STEP_ID = "done";

export const OnboardingFlowStepSchema = z
  .strictObject({
    /** Unique within the flow; the web deep-links it (`/welcome/<id>`). */
    id: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "a step id is a lower-case slug"),
    kind: OnboardingStepKindSchema,
    title: copy(ONBOARDING_TITLE_MAX),
    body: copy(ONBOARDING_BODY_MAX, true),
    /** The host forces `false` for `model`. */
    optional: z.boolean(),
    /** Model: preset ids; channels: channel kinds; apps: app ids. */
    featured: z.array(FlowRefSchema).max(ONBOARDING_FEATURED_MAX).readonly().optional(),
    /** One of `featured`. For the model step it applies only when no tool-capable Ollama is detected. */
    recommended: FlowRefSchema.optional(),
    /** Absent: both. */
    surfaces: z.array(OnboardingSurfaceSchema).min(1).max(ONBOARDING_SURFACES.length).readonly().optional(),
    /**
     * Ideas: the chips shown when there are no ideas and no census chips. `uses`
     * names what a prompt needs; the host drops one the census lacks.
     */
    prompts: z
      .array(
        z.strictObject({
          label: copy(IDEA_LABEL_MAX),
          prompt: copy(IDEA_PROMPT_MAX, true),
          uses: z.array(IdeaCapabilitySchema).min(1).max(IDEA_CAPABILITIES.length).readonly().optional(),
        }),
      )
      .max(ONBOARDING_PROMPTS_MAX)
      .readonly()
      .optional(),
    about: z
      .strictObject({
        fields: z
          .array(z.enum(["name", "timezone", "activeHours"]))
          .min(1)
          .max(3)
          .readonly(),
      })
      .optional(),
    /**
     * Info: the id of the flow plugin's own `onboarding.step` UI
     * contribution, shown under the step's words on the canvas only — sandboxed,
     * with no network and no channel, so no data or secret reaches it.
     */
    frame: ContributionIdSchema.optional(),
  })
  .superRefine((step, context) => {
    // `/welcome/done` is the closing screen: a step by that id could never be shown.
    if (step.id === ONBOARDING_DONE_STEP_ID)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: `"${ONBOARDING_DONE_STEP_ID}" is reserved for the closing screen; name the step something else`,
      });
    if (step.recommended !== undefined && !(step.featured ?? []).includes(step.recommended)) {
      context.addIssue({ code: "custom", path: ["recommended"], message: "recommended must be one of featured" });
    }
    if (step.prompts !== undefined && step.kind !== "ideas")
      context.addIssue({ code: "custom", path: ["prompts"], message: "only an ideas step has prompts" });
    if (step.about !== undefined && step.kind !== "about")
      context.addIssue({ code: "custom", path: ["about"], message: "only an about step has fields" });
    if (step.frame !== undefined && step.kind !== "info")
      context.addIssue({ code: "custom", path: ["frame"], message: "only an info step shows a frame" });
  });
export type OnboardingFlowStep = z.infer<typeof OnboardingFlowStepSchema>;

export const OnboardingFlowSchema = z
  .strictObject({
    abi: z.literal(ONBOARDING_ABI),
    /** Bumped when steps are added; a dismissed checklist comes back once for new steps. */
    version: z.number().int().min(1).max(1_000_000),
    title: copy(ONBOARDING_TITLE_MAX),
    steps: z.array(OnboardingFlowStepSchema).min(1).max(ONBOARDING_FLOW_STEPS_MAX).readonly(),
    done: z.strictObject({ title: copy(ONBOARDING_TITLE_MAX), body: copy(ONBOARDING_BODY_MAX, true) }),
  })
  .superRefine((flow, context) => {
    const ids = new Set<string>();
    const kinds = new Set<OnboardingStepKind>();
    flow.steps.forEach((step, index) => {
      if (ids.has(step.id)) context.addIssue({ code: "custom", path: ["steps", index, "id"], message: `step id ${step.id} is used twice` });
      if (kinds.has(step.kind))
        context.addIssue({ code: "custom", path: ["steps", index, "kind"], message: `a ${step.kind} step appears twice` });
      ids.add(step.id);
      kinds.add(step.kind);
    });
  });
export type OnboardingFlow = z.infer<typeof OnboardingFlowSchema>;

/** What a provider is told: the status, the census, and the *ids* of what is available — no memory, chats or values. */
export interface OnboardingFlowRequest {
  readonly surface: OnboardingSurface;
  readonly status: OnboardingStatus;
  readonly census: readonly IdeaCapability[];
  readonly presets: readonly string[];
  readonly channels: readonly string[];
  readonly apps: readonly string[];
  /** Preset ids detection found, never values. */
  readonly detected: readonly string[];
  /** The workspace's language, when the owner knows it: a flow may choose its words by it. */
  readonly locale?: Locale;
  readonly signal: AbortSignal;
}

/** Chooses the steps and their copy. The host validates the flow and owns status, storage and every write. */
export interface OnboardingProvider {
  flow(request: OnboardingFlowRequest): Promise<OnboardingFlow>;
}

// ------------------------------------------------------------------ detection

/** The env variables detection may name, per preset: a closed list, reported by name only. */
export const ONBOARDING_ENV_KEYS = {
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
export const ONBOARDING_ENV_VARIABLES = Object.values(ONBOARDING_ENV_KEYS).flat() as readonly OnboardingEnvVariable[];
export type OnboardingEnvVariable = (typeof ONBOARDING_ENV_KEYS)[keyof typeof ONBOARDING_ENV_KEYS][number];
export const OnboardingEnvVariableSchema = z.enum(ONBOARDING_ENV_VARIABLES as [OnboardingEnvVariable, ...OnboardingEnvVariable[]]);

/** The preset an allowlisted variable belongs to. */
export function onboardingEnvPreset(variable: OnboardingEnvVariable): keyof typeof ONBOARDING_ENV_KEYS {
  const entry = Object.entries(ONBOARDING_ENV_KEYS).find(([, names]) => (names as readonly string[]).includes(variable));
  return entry?.[0] as keyof typeof ONBOARDING_ENV_KEYS;
}

// ------------------------------------------------------------------ storage

/** What a workspace's step row records; absent, nothing but what this flow created. */
export const ONBOARDING_STEP_MARKS = ["skipped", "seen", "completed", "self-managed"] as const;
export type OnboardingStepMark = (typeof ONBOARDING_STEP_MARKS)[number];
export const OnboardingStepMarkSchema = z.enum(ONBOARDING_STEP_MARKS);

/** The install's one row: flow choice, first-seen and dismissal are per install. */
export const OnboardingInstallSchema = z.object({
  /** Null: the built-in flow. */
  providerId: z.string().min(1).max(128).nullable(),
  firstSeenAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  dismissedAt: TimestampSchema.optional(),
  dismissedFlowVersion: z.number().int().min(1).optional(),
  /** The flow's step kinds when it was dismissed: a newer version's card shows only steps not among them. */
  dismissedStepKinds: z.array(OnboardingStepKindSchema).optional(),
  flowVersion: z.number().int().min(1).optional(),
});
export type OnboardingInstall = z.infer<typeof OnboardingInstallSchema>;

/** One current row per `(workspace, step)`; `createdRef` survives every change of `mark`. */
export const OnboardingStepRecordSchema = z.object({
  workspaceId: IdSchema,
  kind: OnboardingStepKindSchema,
  mark: OnboardingStepMarkSchema.optional(),
  /** The connection id, search provider id or service label this flow created: the only one it may rebind or overwrite. */
  createdRef: z.string().min(1).max(256).optional(),
  at: TimestampSchema,
});
export type OnboardingStepRecord = z.infer<typeof OnboardingStepRecordSchema>;

export const ONBOARDING_VERIFY_SUBJECTS = ["model", "search"] as const;
export type OnboardingVerifySubject = (typeof ONBOARDING_VERIFY_SUBJECTS)[number];

/**
 * A verify's outcome, the latest per `(workspace, subject, role,
 * subjectId)`. `credentialRevision` is `providerCredentialRevision`'s HMAC,
 * never a value. `role` and `model` are absent for search.
 */
export const OnboardingVerificationSchema = z
  .object({
    workspaceId: IdSchema,
    subject: z.enum(ONBOARDING_VERIFY_SUBJECTS),
    role: OnboardingVerifyRoleSchema.optional(),
    /** The connection id for a model, the provider id for search. */
    subjectId: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    baseUrl: z.string().min(1).max(500).optional(),
    credentialRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ok: z.boolean(),
    /** The model called the probe tool (absent for search). */
    toolsOk: z.boolean().optional(),
    /** A `ModelError` code, or one of the kit's advice codes, when not ok. */
    errorCode: z.string().min(1).max(64).optional(),
    at: TimestampSchema,
  })
  .superRefine((verification, context) => {
    if (verification.subject === "model" && (verification.role === undefined || verification.model === undefined)) {
      context.addIssue({ code: "custom", path: ["role"], message: "a model verification names its role and model" });
    }
    if (verification.subject === "search" && (verification.role !== undefined || verification.model !== undefined)) {
      context.addIssue({ code: "custom", path: ["role"], message: "a search verification has no role or model" });
    }
  });
export type OnboardingVerification = z.infer<typeof OnboardingVerificationSchema>;

/** The live target a model verification must match to count (invariant 2): a change to any of these makes it stale. */
export interface OnboardingLiveTarget {
  readonly connectionId: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly credentialRevision: string;
}

/** Whether `verification` was made against `live`: same connection, model, endpoint (normalised) and credential revision. */
export function verificationMatches(verification: OnboardingVerification, live: OnboardingLiveTarget): boolean {
  const endpoint = (url: string) => url.trim().replace(/\/+$/u, "").toLowerCase();
  return (
    verification.subject === "model" &&
    verification.subjectId === live.connectionId &&
    verification.model === live.model &&
    verification.baseUrl !== undefined &&
    endpoint(verification.baseUrl) === endpoint(live.baseUrl) &&
    verification.credentialRevision === live.credentialRevision
  );
}

/** `firstRun`: no model connection, and setup was never finished or dismissed. */
export function onboardingFirstRun(install: OnboardingInstall, hasModelConnection: boolean): boolean {
  return !hasModelConnection && install.completedAt === undefined && install.dismissedAt === undefined;
}

/** The model step's detail when the fast model failed its verify: Ideas and summaries, which run on it, are skipped then. */
export const FAST_MODEL_FAILED = "Fast model failed";
/** The model step's detail for a model that is set up but not checked yet: chats run on it; Verify is offered. */
export const MODEL_NOT_VERIFIED = "not verified yet";
/** Whether `step` is a model set up but not checked yet. */
export function modelUnverified(step: { readonly kind: string; readonly state: string; readonly detail: string } | undefined): boolean {
  return step?.kind === "model" && step.state === "done" && step.detail.includes(`· ${MODEL_NOT_VERIFIED} ·`);
}
/** The command that installs the service, the one step only a terminal can do. */
export const SERVICE_SETUP_COMMAND = "tavi setup service";

/** The advice after `FAST_MODEL_FAILED` in a done model step's detail, or undefined when the fast model did not fail. */
export function fastModelFailure(step: { readonly state: string; readonly detail: string } | undefined): string | undefined {
  if (step?.state !== "done") return undefined;
  const at = step.detail.indexOf(FAST_MODEL_FAILED);
  return at < 0 ? undefined : step.detail.slice(at + FAST_MODEL_FAILED.length).replace(/^:\s*/u, "");
}

/** Setup's funnel events, kept on this machine only. */
export const ONBOARDING_FUNNEL_EVENTS = ["reached", "skipped", "failed"] as const;
export type OnboardingFunnelEvent = (typeof ONBOARDING_FUNNEL_EVENTS)[number];
/** The funnel rows kept; past it the oldest go. */
export const ONBOARDING_EVENTS_MAX = 500;
/** A `reached` this soon after the step's last is the same visit. */
export const ONBOARDING_REACHED_WINDOW_MS = 5 * 60_000;

/** The flow's step kinds at the last dismissal (JSON), beside the install row: what a newer version adds is compared against them. */
export const ONBOARDING_DISMISSED_KINDS_META_KEY = "onboarding.dismissed_step_kinds";

export interface SetOnboardingStepInput {
  readonly workspaceId: string;
  readonly kind: OnboardingStepKind;
  readonly mark: OnboardingStepMark;
  readonly now: string;
}

export interface RecordOnboardingCreatedInput {
  readonly workspaceId: string;
  readonly kind: OnboardingStepKind;
  readonly createdRef: string;
  readonly now: string;
}

/**
 * Onboarding's own tables (migration `0162_onboarding`). Nothing here
 * configures a model, channel or app: those writes go through their own
 * services (invariant 4).
 */
interface OnboardingRepositoryPortDefinition {
  install(): OnboardingInstall;
  /** Null: the built-in flow. */
  setProvider(providerId: string | null): OnboardingInstall;
  /** The first time any surface read the status; later calls keep it. */
  noteSeen(now: string): OnboardingInstall;
  /** The flow version a surface last walked: a later dismissal is compared against it. */
  setFlowVersion(version: number): OnboardingInstall;
  complete(now: string): OnboardingInstall;
  /** Dismiss the checklist card for `flowVersion`, whose steps were `stepKinds`. */
  dismiss(flowVersion: number, now: string, stepKinds?: readonly OnboardingStepKind[]): OnboardingInstall;
  steps(workspaceId: string): readonly OnboardingStepRecord[];
  /** Upsert the step's mark, keeping what this flow created. */
  setStep(input: SetOnboardingStepInput): OnboardingStepRecord;
  /** Record what this flow is about to create (before the first write), keeping the step's mark. */
  recordCreated(input: RecordOnboardingCreatedInput): OnboardingStepRecord;
  /** Undo a skip: the mark goes, and the row too unless it holds what this flow created. Undefined when no row is left. */
  restoreStep(workspaceId: string, kind: OnboardingStepKind, now: string): OnboardingStepRecord | undefined;
  /**
   * `tavi onboard reset`: the workspace's `skipped` and `seen` marks,
   * its funnel events, and the install's dismissal. Keeps the provider, first-seen, seeding,
   * completed and self-managed marks, every `createdRef` and every
   * verification. How many marks were cleared.
   */
  reset(workspaceId: string, now: string): number;
  /**
   * One funnel event: a step reached, skipped or failed, with the
   * failure's code. A `reached` within 5 minutes of the step's last is the same
   * visit, not counted again. At most `ONBOARDING_EVENTS_MAX` rows are kept,
   * the oldest pruned.
   */
  recordEvent(input: {
    readonly workspaceId: string;
    readonly kind: OnboardingStepKind;
    readonly event: OnboardingFunnelEvent;
    readonly errorCode?: string;
    readonly now: string;
  }): void;
  /** The workspace's counts by step, as `status.funnel` answers them. */
  funnel(workspaceId: string): NonNullable<OnboardingStatus["funnel"]>;
  /** Replace the latest verification of its subject. */
  recordVerification(verification: OnboardingVerification): OnboardingVerification;
  verifications(workspaceId: string, subject?: OnboardingVerifySubject): readonly OnboardingVerification[];
}
export type OnboardingRepositoryPort = AsyncRepository<OnboardingRepositoryPortDefinition>;
