/**
 * The `skills` IPC command: a workspace's skills managed through a running
 * owner — the CLI while `tavi serve` holds the directory, and the canvas's
 * Settings → Skills. The operator's only, as memory review is: the owner acts
 * as the workspace's principal.
 */
import { z } from "zod";

import { IdSchema } from "./ids.js";
import {
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_FILE_PATH_CHARS,
  MAX_SKILL_ID_CHARS,
  MAX_PROPOSED_SKILL_BODY_CHARS,
  MAX_SKILL_PACKAGE_BYTES,
  MAX_SKILL_PROVENANCE_CHARS,
  MAX_SKILL_VERSION_CHARS,
  SkillActivationHistoryEntrySchema,
  SkillActivationSchema,
  SkillTraceCallSchema,
  SKILL_TRACE_CALLS_MAX,
  SkillUsageSchema,
  SkillVersionSchema,
} from "./skills.js";

export const SKILLS_ACTIONS = [
  "list",
  "show",
  "body",
  "trace",
  "import",
  "edit",
  "approve",
  "reject",
  "activate",
  "disable",
  "rollback",
] as const;
export type SkillsAction = (typeof SKILLS_ACTIONS)[number];

const skillId = z.string().min(1).max(MAX_SKILL_ID_CHARS);
const version = z.string().min(1).max(MAX_SKILL_VERSION_CHARS);
/** A package's bytes as base64: at most `MAX_SKILL_PACKAGE_BYTES`, which base64 grows by a third. */
const packageBase64 = z
  .string()
  .max(Math.ceil(MAX_SKILL_PACKAGE_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const SkillsPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), workspaceId: IdSchema.optional() }),
  z.strictObject({ action: z.literal("show"), workspaceId: IdSchema.optional(), skillId }),
  /** A version's body as text, naming the version it follows, for a diff. */
  z.strictObject({ action: z.literal("body"), workspaceId: IdSchema.optional(), skillId, version }),
  /** An agent's proposal: the tool calls of the task its evidence names, condensed, for the review. */
  z.strictObject({ action: z.literal("trace"), workspaceId: IdSchema.optional(), skillId, version }),
  z.strictObject({
    action: z.literal("import"),
    workspaceId: IdSchema.optional(),
    skillId,
    version,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    provenance: z.string().min(1).max(MAX_SKILL_PROVENANCE_CHARS),
    packageBase64,
    /** An Agent Skills bundle's declarations (`tavi skills import <folder|SKILL.md|zip>`). */
    allowedTools: z.array(z.string().min(1).max(200)).max(64).optional(),
    compatibility: z.string().max(500).optional(),
    files: z.array(z.string().min(1).max(MAX_SKILL_FILE_PATH_CHARS)).max(MAX_SKILL_BUNDLE_FILES).optional(),
  }),
  /**
   * An agent's proposal, edited by the operator before approving: filed as a
   * new proposed version that follows it (`parentVersion`), with its
   * provenance and evidence kept; the proposal it replaces is set aside
   * (rejected, without a hold on its topic).
   */
  z.strictObject({
    action: z.literal("edit"),
    workspaceId: IdSchema.optional(),
    skillId,
    version,
    body: z.string().min(1).max(MAX_PROPOSED_SKILL_BODY_CHARS),
  }),
  z.strictObject({ action: z.literal("approve"), workspaceId: IdSchema.optional(), skillId, version }),
  z.strictObject({ action: z.literal("reject"), workspaceId: IdSchema.optional(), skillId, version }),
  z.strictObject({
    action: z.literal("activate"),
    workspaceId: IdSchema.optional(),
    skillId,
    version,
    /** The version the writer saw active, so two edits never silently overwrite each other. */
    expectedCurrentVersion: version.optional(),
  }),
  z.strictObject({ action: z.literal("disable"), workspaceId: IdSchema.optional(), skillId, expectedCurrentVersion: version.optional() }),
  z.strictObject({
    action: z.literal("rollback"),
    workspaceId: IdSchema.optional(),
    skillId,
    version,
    expectedCurrentVersion: version.optional(),
  }),
]);
export type SkillsPayload = z.infer<typeof SkillsPayloadSchema>;

/**
 * `list`: every version in the workspace, what each skill has active, and each
 * used skill's use count and last use (`skillUnused` flags a stale one).
 * `usage` is absent from an owner that predates it.
 */
export const SkillsListAnswerSchema = z.strictObject({
  versions: z.array(SkillVersionSchema),
  activations: z.array(SkillActivationSchema),
  usage: z.array(SkillUsageSchema).optional(),
});
export type SkillsListAnswer = z.infer<typeof SkillsListAnswerSchema>;

/** `show`: one skill's versions, what is active, and its activation history. */
export const SkillsShowAnswerSchema = z.strictObject({
  versions: z.array(SkillVersionSchema),
  activation: SkillActivationSchema.optional(),
  history: z.array(SkillActivationHistoryEntrySchema),
});
export type SkillsShowAnswer = z.infer<typeof SkillsShowAnswerSchema>;

/**
 * `body`: a version's text (absent when it is not UTF-8), and the version it
 * follows, whose text a diff reads with another `body`: two packages of up to
 * 512 KiB each would not fit one IPC frame together.
 */
export const SkillsBodyAnswerSchema = z.strictObject({
  version: SkillVersionSchema,
  text: z.string().optional(),
  parentVersion: version.optional(),
});
export type SkillsBodyAnswer = z.infer<typeof SkillsBodyAnswerSchema>;

/**
 * `trace`: the tool calls of the task a proposal's evidence names, as its
 * stored history holds them (`partial` when compaction or the read's bound
 * left some out), condensed: the first `SKILL_TRACE_CALLS_MAX`, `more`
 * counting the rest.
 */
export const SkillsTraceAnswerSchema = z.strictObject({
  taskId: z.string().min(1).max(128),
  calls: z.array(SkillTraceCallSchema).max(SKILL_TRACE_CALLS_MAX),
  more: z.number().int().min(0),
  partial: z.boolean(),
});
export type SkillsTraceAnswer = z.infer<typeof SkillsTraceAnswerSchema>;

/** `edit`: the new proposed version, and the one it set aside. */
export const SkillsEditAnswerSchema = z.strictObject({
  version: SkillVersionSchema,
  replaced: version,
});
export type SkillsEditAnswer = z.infer<typeof SkillsEditAnswerSchema>;
