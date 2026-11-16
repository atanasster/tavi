import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { MemoryProvenanceSchema, memoryProvenanceLine } from "./memory.js";
import { clip } from "./util.js";

/**
 * Approved versioned skills.
 *
 * Basic import/approve/activate/rollback, scoped by workspace.
 */

export const MAX_SKILL_ID_CHARS = 128;
export const MAX_SKILL_VERSION_CHARS = 64;
export const MAX_SKILL_MANIFEST_BYTES = 8 * 1024;
export const MAX_SKILL_PACKAGE_BYTES = 512 * 1024;
export const MAX_SKILL_PROVENANCE_CHARS = 500;

/**
 * Whether a skill's provenance names another author than the operator: a
 * chat's proposal (`chat:<taskId>`) or an outside archive (`archive:…`). Any
 * other provenance is the operator's own wording for their import.
 */
export function skillProvenanceForeign(provenance: string): boolean {
  return /^(chat|archive):/.test(provenance);
}

export const SKILL_REVIEW_STATES = ["proposed", "approved", "rejected"] as const;
export type SkillReviewState = (typeof SKILL_REVIEW_STATES)[number];

/** The most files an Agent Skills bundle holds. */
export const MAX_SKILL_BUNDLE_FILES = 32;
/** The longest path inside a bundle. */
export const MAX_SKILL_FILE_PATH_CHARS = 200;

/** A skill package's non-executable metadata; no download/install hooks. */

export const SkillManifestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /**
     * Retired: version lists nothing ever checked. Still read from an older row
     * as written; absent means none (`[]`), and nothing shows them. A skill's
     * requirements, for a person to read, are its `compatibility`.
     */
    supportedRuntimeVersions: z.array(z.string().min(1).max(32)).max(16).optional(),
    supportedToolContractVersions: z.array(z.string().min(1).max(32)).max(16).optional(),
    /**
     * An Agent Skills package's `allowed-tools`, as it declared them: shown on
     * the review card, and a ceiling on what the skill may call once loaded
     * (never a grant). Absent: the skill declares none.
     */
    allowedTools: z.array(z.string().min(1).max(200)).max(64).optional(),
    /** An Agent Skills package's `compatibility`, shown as written. */
    compatibility: z.string().max(500).optional(),
    /**
     * A skill the agent proposed (`skills.propose`): the task whose outcome it
     * encodes, a short note on how that outcome was checked, and whether the
     * person asked for it. Shown on the review card; never a reason to approve.
     */
    proposal: z
      .strictObject({
        taskId: z.string().min(1).max(128),
        note: z.string().min(1).max(500),
        requested: z.boolean(),
        /**
         * Filed in a turn that had read untrusted content (only when the
         * person asked: an unasked one is refused there) — what that turn
         * read, stamped as `memory.propose` stamps a memory. The review card
         * names it: parts of the text may come from it. Absent: a clean turn.
         */
        untrusted: MemoryProvenanceSchema.optional(),
      })
      .optional(),
    /** A bundle's files by path (`SKILL.md` first), for `skills.read`'s `path`. Absent: one plain text package. */
    files: z.array(z.string().min(1).max(MAX_SKILL_FILE_PATH_CHARS)).max(MAX_SKILL_BUNDLE_FILES).optional(),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/** The format tag a bundle's stored package carries. */
export const SKILL_BUNDLE_FORMAT = "tavi-skill-bundle/1";

/** One file of a bundle: text, or bytes (base64) for one that is not UTF-8. Scripts are text to read, never run. */
export interface SkillBundleFile {
  readonly path: string;
  readonly text?: string;
  readonly base64?: string;
}

/**
 * A package as files: a bundle's (`SKILL_BUNDLE_FORMAT`, sorted by path), or a
 * plain package as one `SKILL.md`. `undefined` when the text is a JSON object
 * that claims the bundle format but is not one.
 */
/** A bundle's files as a review shows them: `SKILL.md` first, then by path. */
export function skillBundleFilesForReview(files: readonly SkillBundleFile[]): readonly SkillBundleFile[] {
  return [...files].sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1));
}

/** A file's size in bytes: its text's UTF-8 length, or what its base64 decodes to. */
export function skillBundleFileBytes(file: SkillBundleFile): number {
  if (file.text !== undefined) return new TextEncoder().encode(file.text).length;
  const base64 = file.base64 ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function skillPackageFiles(text: string): readonly SkillBundleFile[] | undefined {
  if (!text.startsWith(`{"format":"${SKILL_BUNDLE_FORMAT}"`)) return [{ path: "SKILL.md", text }];
  try {
    const parsed = JSON.parse(text) as { readonly format?: unknown; readonly files?: unknown };
    if (parsed.format !== SKILL_BUNDLE_FORMAT || !Array.isArray(parsed.files)) return undefined;
    const files = parsed.files as SkillBundleFile[];
    return files.every((file) => typeof file?.path === "string" && (typeof file.text === "string" || typeof file.base64 === "string"))
      ? files
      : undefined;
  } catch {
    return undefined;
  }
}

/** A bundle's stored text: its files sorted by path, so the same files are the same bytes (and the same hash). */
export function skillBundleText(files: readonly SkillBundleFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({
    format: SKILL_BUNDLE_FORMAT,
    files: sorted.map((file) =>
      file.text === undefined ? { path: file.path, base64: file.base64 } : { path: file.path, text: file.text },
    ),
  });
}

export const SkillVersionSchema = z.object({
  skillId: z.string().min(1).max(MAX_SKILL_ID_CHARS),
  version: z.string().min(1).max(MAX_SKILL_VERSION_CHARS),
  /** The published package artifact's own sha256; immutable once written. */
  contentHash: z.string().min(1).max(128),
  parentVersion: z.string().max(MAX_SKILL_VERSION_CHARS).optional(),
  /** A skill is scoped to one workspace. */
  scopeKey: z.string().min(1).max(256),
  manifest: SkillManifestSchema,
  provenance: z.string().min(1).max(MAX_SKILL_PROVENANCE_CHARS),
  reviewState: z.enum(SKILL_REVIEW_STATES),
  packageArtifactId: IdSchema,
  importedBy: IdSchema,
  importedAt: TimestampSchema,
  reviewedBy: IdSchema.optional(),
  reviewedAt: TimestampSchema.optional(),
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

/** How long an agent's proposal waits for review before it is shown as expired. */
export const SKILL_PROPOSAL_EXPIRY_DAYS = 30;

/**
 * Whether an agent's proposal (`skills.propose`) has waited for review past
 * `SKILL_PROPOSAL_EXPIRY_DAYS`: still `proposed` and still the person's to
 * approve or reject — nothing rejects it for them — but shown as expired, and
 * no longer counted against the cap on proposals waiting.
 */
export function skillProposalExpired(version: Pick<SkillVersion, "reviewState" | "importedAt" | "manifest">, now: string): boolean {
  return (
    version.reviewState === "proposed" &&
    version.manifest.proposal !== undefined &&
    Date.parse(now) - Date.parse(version.importedAt) > SKILL_PROPOSAL_EXPIRY_DAYS * 86_400_000
  );
}

/** The longest text of a proposed skill: the agent's draft, or the operator's edit of it. */
export const MAX_PROPOSED_SKILL_BODY_CHARS = 64_000;

/** How long a turned-down proposal keeps its topic from being offered again, unasked. */
export const SKILL_DISMISSED_TOPIC_DAYS = 30;

/** The tool an agent proposes a skill with. */
export const SKILLS_PROPOSE_TOOL_ID = "skills.propose";

/** The chat a proposal came from (`chat:<taskId>`): where its feedback goes; `undefined` for any other provenance. */
export function skillProposalChatOf(version: Pick<SkillVersion, "provenance">): string | undefined {
  return version.provenance.startsWith("chat:") ? version.provenance.slice("chat:".length) || undefined : undefined;
}

/** The version a `skills.propose` call's output names, or `undefined` when it names none (a failed call, a saved turn's line). */
export function skillProposedOf(output: unknown): { readonly skillId: string; readonly version: string } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const { skillId, version } = output as { readonly skillId?: unknown; readonly version?: unknown };
  return typeof skillId === "string" && typeof version === "string" ? { skillId, version } : undefined;
}

/** A terminal's one line under a proposal's call: where it waits, and the command that shows it. */
export function skillProposalNoticeLine(skillId: string, version: string): string {
  return `A skill waits for your review: ${skillReviewCommand(skillId, version)}`;
}

/** The command that shows a proposal for review: the one line a terminal or a channel says of it. */
export function skillReviewCommand(skillId: string, version: string): string {
  return `tavi skills show ${skillId} --body --version ${version}`;
}

/**
 * What a review says of a proposal filed after its turn read untrusted
 * content: what it read (`memoryProvenanceLine`), and that parts of the text
 * may come from there. Tavi cannot tell which words did, so the whole text is
 * flagged, not spans of it. `undefined` for a clean turn's.
 */
export function skillProposalUntrustedLine(version: Pick<SkillVersion, "manifest">): string | undefined {
  const line = memoryProvenanceLine(version.manifest.proposal?.untrusted);
  return line === undefined
    ? undefined
    : `${line}. Parts of this text may come from that content, not from you or the agent's own steps: read it closely before approving.`;
}

/**
 * A proposal set aside by an edit: rejected, with a later proposal from the
 * same chat that follows it (`parentVersion`). The edit, not the person
 * turning the topic down: no 30-day hold.
 */
export function skillProposalEditedInto(
  version: Pick<SkillVersion, "skillId" | "version" | "provenance" | "reviewState" | "manifest">,
  versions: readonly Pick<SkillVersion, "skillId" | "version" | "parentVersion" | "provenance" | "manifest">[],
): string | undefined {
  if (version.reviewState !== "rejected" || version.manifest.proposal === undefined) return undefined;
  return versions.find(
    (other) =>
      other.skillId === version.skillId &&
      other.parentVersion === version.version &&
      other.provenance === version.provenance &&
      other.manifest.proposal !== undefined,
  )?.version;
}

/** The longest feedback a person sends back on a proposal. */
export const SKILL_FEEDBACK_MAX_CHARS = 4_000;

/**
 * Regenerate-with-feedback: the message sent, as the person's own, to the
 * chat a proposal came from. It asks the agent to propose again — asked for,
 * so no cap on unasked offers holds it — with the feedback; the proposal it
 * follows still waits, for the person to reject or keep.
 */
export function skillRegenerateMessage(version: Pick<SkillVersion, "skillId" | "version" | "manifest">, feedback: string): string {
  return [
    `Please propose the skill "${version.manifest.name}" (${version.skillId}) again with skills.propose, changed as my feedback below says. I am asking for it, so set requested to true. It replaces ${version.skillId}@${version.version}, which still waits for my review.`,
    "",
    "My feedback:",
    feedback.trim(),
  ].join("\n");
}

/** The most calls a proposal's tool trace shows; the rest are counted. */
export const SKILL_TRACE_CALLS_MAX = 40;
/** How much of a call's input the trace shows. */
export const SKILL_TRACE_INPUT_CHARS = 100;

/** A tool call as a trace reads it: its name, its input, and how it ended. */
export interface SkillTraceSource {
  readonly toolName: string;
  readonly input?: unknown;
  readonly status: "running" | "completed" | "failed" | "interrupted";
}

/** One call of a condensed trace: the tool, its input on one line clipped to `SKILL_TRACE_INPUT_CHARS`, and how it ended. */
export const SkillTraceCallSchema = z.strictObject({
  toolName: z.string().min(1).max(128),
  input: z.string().max(SKILL_TRACE_INPUT_CHARS),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
});
export type SkillTraceCall = z.infer<typeof SkillTraceCallSchema>;

/**
 * Untrusted text as one trace line: control characters, and the bidi and
 * format controls that would reorder how the line reads, become a space;
 * white space folded, clipped.
 */
function traceText(text: string, max: number): string {
  return clip(text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " "), max, { squeeze: true });
}

/** A call's input on one line: its JSON, as `traceText` cleans it. */
function traceInput(input: unknown): string {
  if (input === undefined) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  } catch {
    text = "";
  }
  return traceText(text, SKILL_TRACE_INPUT_CHARS);
}

/** A task's tool calls condensed for a proposal's review: the first `SKILL_TRACE_CALLS_MAX`, each its name and a short input; `more` counts the rest. */
export function condenseSkillTrace(tools: readonly SkillTraceSource[]): {
  readonly calls: readonly SkillTraceCall[];
  readonly more: number;
} {
  const calls = tools.slice(0, SKILL_TRACE_CALLS_MAX).map((tool) => ({
    toolName: traceText(tool.toolName, 128) || "?",
    input: traceInput(tool.input),
    status: tool.status,
  }));
  return { calls, more: Math.max(0, tools.length - calls.length) };
}

/** A trace call as one line: `web_fetch {"url":"…"} — failed`. */
export function skillTraceLine(call: SkillTraceCall): string {
  return `${call.toolName}${call.input === "" ? "" : ` ${call.input}`}${call.status === "completed" ? "" : ` — ${call.status}`}`;
}

export const SkillActivationSchema = z.object({
  scopeKey: z.string().min(1).max(256),
  skillId: z.string().min(1).max(MAX_SKILL_ID_CHARS),
  activeVersion: z.string().min(1).max(MAX_SKILL_VERSION_CHARS),
  activatedBy: IdSchema,
  activatedAt: TimestampSchema,
});
export type SkillActivation = z.infer<typeof SkillActivationSchema>;

/**
 * `disable`: disables the
 * skill entirely if no compatible prior version exists — a rollback
 * target that turns out to be unavailable clears the activation pointer
 * rather than leaving a stale or invalid one in place. No `SkillVersion`
 * is associated with a `disable` entry — see `newVersion` below.
 */
export const SKILL_ACTIVATION_REASONS = ["activate", "rollback", "disable"] as const;
export type SkillActivationReason = (typeof SKILL_ACTIVATION_REASONS)[number];

export const SkillActivationHistoryEntrySchema = z.object({
  historyId: IdSchema,
  scopeKey: z.string().min(1).max(256),
  skillId: z.string().min(1).max(MAX_SKILL_ID_CHARS),
  previousVersion: z.string().max(MAX_SKILL_VERSION_CHARS).optional(),
  /** Absent exactly when `reason: "disable"` — a disable entry clears the activation pointer rather than pointing it at a new version. */
  newVersion: z.string().min(1).max(MAX_SKILL_VERSION_CHARS).optional(),
  reason: z.enum(SKILL_ACTIVATION_REASONS),
  actor: IdSchema,
  at: TimestampSchema,
});
export type SkillActivationHistoryEntry = z.infer<typeof SkillActivationHistoryEntrySchema>;

/**
 * One activation-history entry in words, for the Skills viewer and `tavi skills show`: "Activated 2.0.0 (was 1.0.0)",
 * "Rolled back to 1.0.0 (was 2.0.0)", "Disabled (was 1.0.0)". When and by whom are the caller's to add.
 */
export function skillActivationHistoryText(entry: Pick<SkillActivationHistoryEntry, "reason" | "previousVersion" | "newVersion">): string {
  const was = entry.previousVersion === undefined ? "" : ` (was ${entry.previousVersion})`;
  switch (entry.reason) {
    case "activate":
      return `Activated ${entry.newVersion ?? "none"}${was}`;
    case "rollback":
      return `Rolled back to ${entry.newVersion ?? "none"}${was}`;
    case "disable":
      return `Disabled${was}`;
  }
}

/**
 * One of a workspace's currently active skills, with its manifest — the
 * "approved skill/tool manifest" stage of context assembly. Computed from
 * `SkillRepositoryPort.listActivations` joined against
 * each activation's `SkillVersion`, never persisted itself.
 */
export interface ActiveSkill {
  readonly skillId: string;
  readonly version: string;
  readonly manifest: SkillManifest;
}

/** Where a skill was used: a chat's `skills.read`, or a routine run's pinned skill. */
export const SKILL_USE_SOURCES = ["chat", "routine"] as const;
export type SkillUseSource = (typeof SKILL_USE_SOURCES)[number];

/** A skill counts as unused once this many days pass without a use while it is active. */
export const SKILL_UNUSED_DAYS = 60;
/** How long a use is kept: older ones are pruned as new ones are recorded. */
export const SKILL_USE_RETENTION_DAYS = 365;
/** The most uses kept for one skill in a workspace: the oldest past it are pruned. */
export const MAX_SKILL_USES_PER_SKILL = 1000;

/**
 * One use of a skill: which task loaded which version, when, and from where.
 * Metadata only, never the body's text. A task that loads the same version
 * again (another page, another file) is the same use, its `usedAt` moved on.
 */
export const SkillUseSchema = z.strictObject({
  scopeKey: z.string().min(1).max(256),
  /** The chat's task, or for a routine the run's id (one run is one use, however often it resumes). */
  taskId: z.string().min(1).max(128),
  skillId: z.string().min(1).max(MAX_SKILL_ID_CHARS),
  version: z.string().min(1).max(MAX_SKILL_VERSION_CHARS),
  usedAt: TimestampSchema,
  source: z.enum(SKILL_USE_SOURCES),
});
export type SkillUse = z.infer<typeof SkillUseSchema>;

/** A skill's kept uses in a workspace (the last `SKILL_USE_RETENTION_DAYS`, at most `MAX_SKILL_USES_PER_SKILL`) and the latest. */
export const SkillUsageSchema = z.strictObject({
  skillId: z.string().min(1).max(MAX_SKILL_ID_CHARS),
  uses: z.number().int().min(0),
  lastUsedAt: TimestampSchema,
});
export type SkillUsage = z.infer<typeof SkillUsageSchema>;

/**
 * Whether an active skill has gone `SKILL_UNUSED_DAYS` without a use: counted
 * from its last use, or from its activation when it was never used since, so a
 * skill activated yesterday is not flagged. An inactive skill never is.
 */
export function skillUnused(input: { readonly lastUsedAt?: string; readonly activatedAt?: string }, now: number = Date.now()): boolean {
  if (input.activatedAt === undefined) return false;
  const since = Math.max(Date.parse(input.activatedAt), input.lastUsedAt === undefined ? 0 : Date.parse(input.lastUsedAt));
  return now - since >= SKILL_UNUSED_DAYS * 86_400_000;
}

/** A skill's use as a listing shows it: the kept count, the latest, and whether it went stale (`skillUnused`). */
export interface SkillUseSummary {
  readonly uses: number;
  readonly lastUsedAt?: string;
  readonly unused: boolean;
}

/**
 * Each skill's use from a list answer, joined on `skillId` with its usage and
 * its activation: an answer that carries no `usage` reads as never used. The
 * CLI's `skills list` and the canvas's Skills panel both read it.
 */
export function skillUsageOf(
  answer: {
    readonly usage?: readonly Pick<SkillUsage, "skillId" | "uses" | "lastUsedAt">[] | undefined;
    readonly activations: readonly { readonly skillId: string; readonly activatedAt: string }[];
  },
  now: number = Date.now(),
): (skillId: string) => SkillUseSummary {
  const usage = new Map((answer.usage ?? []).map((entry) => [entry.skillId, entry]));
  const activated = new Map(answer.activations.map((activation) => [activation.skillId, activation.activatedAt]));
  return (skillId) => {
    const used = usage.get(skillId);
    const activatedAt = activated.get(skillId);
    const lastUsed = used === undefined ? {} : { lastUsedAt: used.lastUsedAt };
    return {
      uses: used?.uses ?? 0,
      ...lastUsed,
      unused: skillUnused({ ...lastUsed, ...(activatedAt === undefined ? {} : { activatedAt }) }, now),
    };
  };
}

/** A skill's use in words: "never used", or "3 uses, last 2026-10-20". */
export function skillUsageText(usage: Pick<SkillUseSummary, "uses" | "lastUsedAt">): string {
  return usage.lastUsedAt === undefined
    ? "never used"
    : `${String(usage.uses)} use${usage.uses === 1 ? "" : "s"}, last ${usage.lastUsedAt.slice(0, 10)}`;
}
