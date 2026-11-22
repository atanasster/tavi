import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema } from "./ids.js";
// Acyclic: content-label.ts imports only zod.
import {
  CONTENT_LABEL_LIMITS,
  LabelSummarySchema,
  UNTRUSTED_UNKNOWN_SOURCE,
  isUntrusted,
  joinLabels,
  labelSummary,
  type ContentLabel,
} from "./content-label.js";
import { isKnownNavigation, isKnownUrl, navigationKeyOf, normalizeUrl, KNOWN_URL_LIMITS } from "./known-url.js";
import { hostAndPathOf } from "./url-text.js";
// Acyclic: argument-provenance.ts imports only zod, content-label.ts and terminal-text.ts.
import { ARG_PROVENANCE_LIMITS, ArgOriginSchema } from "./argument-provenance.js";
import { ToolEffectSchema, ToolIdSchema, ToolSinkSchema, type ToolEffect, type ToolSink } from "./tools.js";
import { originCovers, TASK_ORIGINS } from "./task-origins.js";
import { SourceStatusSchema, type SourceStatus } from "./pdf.js";
import { ApprovalDisplaySchema, clipDisplay, displayHides, type ApprovalDisplay, cardText, clipText } from "./approval-card.js";
// Acyclic: skill-ceiling.ts imports only zod.
import {
  SkillCeilingSchema,
  skillCeilingAllows,
  skillCeilingRefusal,
  type SkillCeiling,
  type SkillCeilingSummary,
} from "./skill-ceiling.js";
import { coreEnglish, type CoreT } from "./locales/core.js";

/**
 * Tool policy.
 *
 * Whether a tool call runs, waits for a person, or is refused is decided once,
 * when the model emits the call, and the verdict is checkpointed with the call.
 * `approveNode` and `toolsNode` read that verdict and never re-evaluate: a rule
 * or session grant created while a round is pending must not change which calls
 * that round gates, because the round's resume value is matched to the
 * interrupt the node raised the first time.
 *
 * Evaluation order: hard deny → deny rules → the taint step → the skill
 * ceiling → ask rules → allow rules → session grants → the adapter's effect default. The first match
 * wins, and nothing overrides a deny. A `critical` call is asked even when a
 * rule allows it.
 *
 * The taint step: in a
 * tainted conversation, a call whose sink lets data leave the chat, uses a
 * credential or outlives the chat asks once, with a `gateReason`, and no allow
 * rule, session grant, `serve --allow` flag rule or `alwaysAnyCall` lifts it.
 * A schedule fire denies such a round, whatever its tool list:
 * the round's request entries carry `gateReason`, `tainted` and
 * `askWhenTainted` for it (`unattendedDenial`).
 */

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const APPROVAL_SCOPES = ["once", "session", "always"] as const;
export const ApprovalScopeSchema = z.enum(APPROVAL_SCOPES);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ToolRuleDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type ToolRuleDecision = z.infer<typeof ToolRuleDecisionSchema>;

/** Whether a pattern names the web tools by their retired dotted ids (`web.search`, `web.*`), which match no tool. */
export function isStaleWebPattern(pattern: string): boolean {
  return pattern.startsWith("web.");
}

/**
 * What a person calls a group of tools decided as one, for every front end's
 * approval card: `browser.*` is "browser" ("use the browser"), or "browser on
 * example.com" given the hosts its round opens; `web_search` "web search".
 */
export function toolGroupLabel(group: string, hosts: readonly string[] = [], t: CoreT = coreEnglish): string {
  // The browser is allowed on the hosts its round opens (`display.host`), never on every site: the card names them.
  if (group === "browser.*")
    return hosts.length === 0 ? t("tool.group.browser") : t("tool.group.browserOn", { hosts: [...new Set(hosts)].join(", ") });
  if (group === "web_search") return t("tool.group.webSearch");
  if (group === "web_*") return t("tool.group.webTools");
  if (group === "travel.*") return t("tool.group.travelSearch");
  return t("tool.group.other", { group });
}

/** What a grouped card adds after what it allows: for the browser, that another site is asked about again. */
export function toolGroupScopeNote(group: string, t: CoreT = coreEnglish): string | undefined {
  return group === "browser.*" ? t("tool.group.scopeNote.browser") : undefined;
}

/** Why a dotted `web.` pattern is refused. */
export function staleWebPatternMessage(t: CoreT = coreEnglish): string {
  return t("tool.pattern.staleWeb");
}

/** `staleWebPatternMessage` in English: a schema's refinement message. */
export const STALE_WEB_PATTERN_MESSAGE = staleWebPatternMessage();

/** A tool id, or a dotted glob whose `*` segments match one segment each (`browser.*`). `*` alone matches every tool. */
export const ToolPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(\*|web_(?:search|fetch|\*)|[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))+)$/,
    'tool patterns look like "web_search", "browser.*" or "*"',
  )
  .refine((pattern) => !isStaleWebPattern(pattern), STALE_WEB_PATTERN_MESSAGE);

/** A glob over a call's subjects: `*` matches any run of characters, `?` one. Anchored at both ends. */
export const ArgMatcherSchema = z.string().min(1).max(512);

export const TOOL_RULE_SOURCES = ["shipped", "flag", "operator"] as const;
export const TOOL_RULE_ORIGINS = ["cli", "ipc", "bridge", "channel", "config"] as const;

export const ToolRuleSchema = z.strictObject({
  ruleId: IdSchema,
  /** `*` for a shipped rule, which applies in every workspace. */
  workspaceId: z.string().min(1).max(128),
  toolPattern: ToolPatternSchema,
  argMatcher: ArgMatcherSchema.optional(),
  bindingHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  decision: ToolRuleDecisionSchema,
  source: z.enum(TOOL_RULE_SOURCES),
  createdBy: z.string().min(1).max(128),
  createdVia: z.enum(TOOL_RULE_ORIGINS),
  createdAt: z.string().min(1).max(64),
  note: z.string().max(500).optional(),
  /**
   * An `always` approval wrote it — a person approved a call — rather than an
   * operator writing it (`permissions add`, `serve --allow`, config). Rules
   * stored before the marker are known by their note (`APPROVAL_RULE_NOTE_PREFIX`).
   */
  fromApproval: z.literal(true).optional(),
  /**
   * Applies only to tasks started this way: a tool profile, such as
   * the messaging profile that keeps shell and file writes from a chat unless
   * the owner enables them. Absent applies to every task. A rule scoped to
   * `ipc` also covers `web` tasks.
   */
  origin: z.enum(TASK_ORIGINS).optional(),
  /**
   * An allow rule that also covers a call no rule can read
   * (`CallAssessment.unparsed`: a shell line with `$(…)`, `eval`, a
   * here-document): written on purpose (`permissions add --match-unparsed`),
   * since a blanket allow would otherwise let them through unread.
   */
  matchUnparsed: z.literal(true).optional(),
  /**
   * An allow rule for only the calls the tool's assessor reads as read-only
   * (`CallAssessment.readOnly`): what they do is print what they read, so
   * they need no person's say. Its matcher is unused; a deny or ask rule
   * still holds them.
   */
  readOnly: z.literal(true).optional(),
});
export type ToolRule = z.infer<typeof ToolRuleSchema>;

/**
 * What a tool's `checkSources` found of one call, before the person is
 * asked: a refusal, which denies the call
 * before any card, naming the field and why; or each row's status, in row
 * order, and the hash that binds what the statuses were checked against
 * (the call's `contentHash`, which the handler receives as
 * `approvedContentHash`).
 */
export type SourceCheck =
  | { readonly refused: string }
  | {
      readonly statuses: readonly SourceStatus[];
      readonly contentHash: string;
      /** A note on a row's source the check learned, by row: whose attachment it is when not the person's. */
      readonly notes?: readonly (string | undefined)[];
    };

/** What the gate hands `checkSources`: the person's own messages in the provenance window, newest first. */
export interface SourceCheckContext {
  readonly personTexts: readonly string[];
  /**
   * The artifacts the conversation's attachment lines name, in the
   * provenance window: an attachment source must be one of them. Absent,
   * not known (a write after the round).
   */
  readonly conversationArtifacts?: readonly string[];
  /** The run's cancellation: a check reading files or records stops with it. */
  readonly signal?: AbortSignal;
}

/**
 * A tool's own reading of one call (`ToolRegistration.assess`).
 *
 * `subjects` are the strings rule matchers are tested against: one per shell
 * subcommand, `METHOD url` for a request, `connection:chat` for a message. A
 * call with no subjects can match only a rule without a matcher. `hardDeny` is
 * a refusal no rule, grant or mode can lift.
 */
export interface CallAssessment {
  readonly bindingHash?: string;
  readonly display: ApprovalDisplay;
  readonly subjects: readonly string[];
  readonly risk: RiskLevel;
  readonly reasons: readonly string[];
  readonly hardDeny?: string;
  /**
   * The person is not shown the whole call (a diff too long to show): a
   * decision covers this call only, never a grant or rule for more like it.
   */
  readonly onceOnly?: boolean;
  /**
   * What the call runs cannot be read as plain commands (`$(…)`, `eval`, a
   * here-document, two parsers that disagree): no allow rule or grant lifts
   * it, but a rule written with `matchUnparsed`.
   */
  readonly unparsed?: boolean;
  /**
   * More spellings of what the call runs — wrappers removed, the program's
   * basename, quotes gone (`env curl x` as `curl x`) — which deny and ask
   * rules match as well as `subjects`; allow rules and grants never read them,
   * so these only ever make a call stricter.
   */
  readonly forms?: readonly string[];
  /**
   * The call only reads and prints (`ls`, `git status`, `rg TODO`): a rule
   * marked `readOnly` allows it. Its assessor sets it only when nothing in
   * the call writes, runs another program, reaches the network or leaves the
   * working folder.
   */
  readonly readOnly?: boolean;
  /**
   * The matchers a `session` decision stores instead of the subjects'
   * own (`cargo check`, `cargo check *` for `cargo check --release`), so a
   * grant for the rest of the chat covers a command's variants. They must
   * cover every subject; absent: exactly what was shown. The card says what
   * they cover.
   */
  readonly sessionMatchers?: readonly string[];
  /**
   * A tool pattern (`browser.*`) a `session` or `always` decision covers as a
   * whole: the tools are one permission to a person — "use the browser" — so
   * allowing one allows them all, and the subjects do not narrow it.
   */
  readonly scopeGroup?: string;
  /**
   * With `scopeGroup`: the host the call acts on — the page a browser click,
   * typing or screenshot lands on. A grouped decision is for the hosts its
   * call named, so a grant covers this call only when it carries this host:
   * after a click or a redirect takes the page to another site, the next
   * call there asks again. Allow and deny rules read it as a subject too.
   * Without `scopeGroup` (a submit, an upload, a dialog accept): the host the
   * call is still held to when it runs (`GateVerdict.decidedHosts`), so a page
   * that moved to another site while it waited for a person is refused.
   */
  readonly scopeHost?: string;
  /**
   * With `scopeHost`: the other hosts the call acts on — a browser batch whose
   * steps land in frames on other sites. The call is decided for all of them,
   * as its steps sent one by one would be: a grant covers it only when it
   * covers every one, and a rule naming any of them holds it.
   */
  readonly additionalHosts?: readonly string[];
  /**
   * The call asks when the conversation holds untrusted content, whatever a
   * rule or grant allows: an assessor cannot see the conversation, so the gate
   * applies this. A reminder that starts a task, or changes or cancels one,
   * sets it, so injected text cannot schedule work or quietly delete
   * someone's reminder.
   */
  readonly askWhenTainted?: boolean;
  /**
   * Only a person decides the call: the gate always asks it, once, whatever
   * an allow rule, a grant or the gated effects say (a deny rule or a hard
   * deny still refuses it), and no run nobody attends may answer it, whatever
   * its tool list or approve-all (`unattendedDenial`). `pdf.fill` sets it:
   * the approval card is the person's review of every value.
   * A mailbox's `send_draft` does too:
   * its card is the draft shown whole.
   */
  readonly attendedOnly?: boolean;
  /**
   * This call's effect, when it is more than the tool's declared one: a
   * read-only video tool whose analyser is remote sends the person's video
   * off the machine, so that call is `external`. Raise-only
   * (`effectiveEffect`): an assessment that names a
   * lesser effect is ignored. The gate decides by it, and the verdict keeps
   * it, so dispatch and recovery use what was approved, never a recomputation.
   */
  readonly effect?: ToolEffect;
  /**
   * `always` is offered as a rule for any call of the tool, with no subjects
   * and under taint: the tool's calls differ only in what they ask,
   * not where they go, so the call in front of the person — injected or not —
   * shapes nothing the rule allows. `web_search` sets it.
   */
  readonly alwaysAnyCall?: boolean;
  /**
   * Other tools whose deny and ask rules hold this call too: `browser.batch`
   * runs `browser.act` steps, so a rule a person wrote to refuse or ask about an
   * act refuses or asks about the same step in a batch. Allow rules are not
   * borrowed: a batch is allowed by its own rules and grants.
   */
  readonly ruleAliases?: readonly string[];
  /**
   * A digest of what the person is shown that the input does not carry — the
   * sha256 of a file a call sends out of the chat's folder. Kept on the
   * verdict and handed to the handler with the approval
   * (`ToolHandler.approvedContentHash`), which refuses content that changed
   * since it was shown.
   */
  readonly contentHash?: string;
  /**
   * The subjects are paths on a filesystem that may fold case and Unicode
   * forms (macOS, Windows): there `.ENV` opens the `.env` a deny rule names. A
   * deny or ask rule then matches them folded as the filesystem would (`fsFold`) as well
   * as exactly; an allow rule still matches exactly — matching less is its
   * safe side.
   */
  readonly foldCase?: boolean;
  /**
   * This call's sink, when it differs from the tool's static one: an
   * `http.request` with a credential is `credential`, an `fs.write` inside the
   * chat's managed folder `none`. Absent: the tool's `ToolDefinition.sink`.
   */
  readonly sink?: ToolSink;
  /** With a `network` sink: the URL is this call's only model-chosen payload. Absent: the tool's `urlOnly`. */
  readonly urlOnly?: boolean;
  /** The URLs a `urlOnly` call would request, as the input names them: each must be known under taint. */
  readonly urls?: readonly string[];
  /**
   * URLs the tool's own host state makes known, though the conversation may
   * not show them: a heartbeat's watched pages and the links its check read.
   * Built-in assessors only; never what the input claims.
   */
  readonly vouchedUrls?: readonly string[];
  /**
   * A browser call judged one step at a time: `inert` steps (a click,
   * a scroll, a key that types nothing) skip; a `navigate` step is judged as a
   * `urlOnly` call of its `url`, fragment included; a `type` step is allowed
   * under taint on an origin the task reached through a known URL or an
   * approval (its `url`, the page typed into, when the tool knows it); a
   * `send` step (submit, upload, download, acting by sight) is a
   * `tainted-payload` ask, once only, as its shipped ask rule asks.
   */
  readonly browserSteps?: readonly BrowserStep[];
  /**
   * A `reply` call whose destination is a group or a forum topic, as the
   * conversation was read at admission (`InvocationContext.memoryReach`):
   * other members read it, so under [A]∧[B] it asks once
   * (`private-group-reply`). Absent: a one-to-one reply.
   */
  readonly groupDestination?: boolean;
  /**
   * A browser session opened on the workspace's profile, with the person's
   * cookies and sign-ins (`browser.create_session` without
   * `profile: "ephemeral"`): under taint it asks once (`signed-in-browser`),
   * whatever the page, since an injected instruction could steer the model
   * into the person's signed-in accounts. A signed-out session never asks for it.
   */
  readonly signedInProfile?: boolean;
}

export const BROWSER_STEP_KINDS = ["inert", "navigate", "type", "send"] as const;
export type BrowserStepKind = (typeof BROWSER_STEP_KINDS)[number];
export interface BrowserStep {
  readonly kind: BrowserStepKind;
  readonly url?: string;
}

/** How the taint step applies (`security.taint`): `observe` records what it would ask and decides as before it existed. */
export const TAINT_MODES = ["off", "observe", "enforce"] as const;
export const TaintModeSchema = z.enum(TAINT_MODES);
export type TaintMode = z.infer<typeof TaintModeSchema>;
/**
 * `security.taint` where a workspace sets nothing: it enforces — a tainted
 * chat's risky calls are asked about, once, whatever a rule or grant allows.
 * `observe` stays an explicit opt-out, warned about at `serve` start and by `tavi doctor`.
 */
export const DEFAULT_TAINT_MODE: TaintMode = "enforce";

/**
 * Why the gate asked once, whatever a rule or grant allows: the taint step's
 * reasons (`private-search` and `private-group-reply` need the
 * confidentiality label), and `outside-skill-ceiling` — a call outside the
 * `allowed-tools` of a skill loaded this turn (`skill-ceiling.ts`), which is
 * no taint and is never recorded as one.
 */
export const GATE_REASONS = [
  "novel-url",
  "tainted-payload",
  "tainted-message",
  "credential-under-taint",
  "tainted-persist",
  "private-search",
  "private-group-reply",
  "signed-in-browser",
  "outside-skill-ceiling",
] as const;
export const GateReasonSchema = z.enum(GATE_REASONS);
export type GateReason = z.infer<typeof GateReasonSchema>;

/** Whether a gate reason is the taint step's: the chat read untrusted content. */
export function isTaintGateReason(reason: GateReason | undefined): boolean {
  return reason !== undefined && reason !== "outside-skill-ceiling";
}

/**
 * One call the taint step asked, or would have asked (migration
 * `0138_gate_observations`): tool ids and reasons only, never arguments.
 * `decisionEnforced` is what the gate decided; `decisionObserved` is what the
 * taint step decides (`ask`). Recorded under `observe` for every call the
 * step would have asked, and under `enforce` for every call it asked, so
 * `tavi doctor` reads one table in either mode. An unattended routine's or
 * heartbeat's denial is recorded as `deny`; a schedule fire's or
 * `--approval approve`'s refusal of the round is recorded as the gate's `ask`.
 */
export const GateObservationSchema = z.strictObject({
  taskId: IdSchema,
  callId: z.string().min(1).max(256),
  toolId: z.string().min(1).max(128),
  effect: ToolEffectSchema,
  sink: ToolSinkSchema.optional(),
  decisionEnforced: ToolRuleDecisionSchema,
  decisionObserved: ToolRuleDecisionSchema,
  gateReason: GateReasonSchema,
  createdAt: z.string().min(1).max(64),
});
export type GateObservation = z.infer<typeof GateObservationSchema>;

/** How long a gate observation is kept: pruned with the expired chat grants, at start and hourly. */
export const GATE_OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The window and length of `tavi doctor`'s taint line. */
export const GATE_OBSERVATION_DOCTOR_DAYS = 7;
export const GATE_OBSERVATION_TOP_TOOLS = 5;

/** The observations since an instant, counted: `tavi doctor`'s taint section. */
export interface GateObservationSummary {
  /** Calls the taint step asked, or would have asked. */
  readonly calls: number;
  /** Tasks they were in. */
  readonly tasks: number;
  /** Of `calls`, those the gate let run unasked: the approvals `enforce` would add. */
  readonly unasked: number;
  /** The most observed tools, most first (ties by id). */
  readonly topTools: readonly { readonly toolId: string; readonly calls: number }[];
}

/** The observation a verdict carries, if any: a taint ask enforced, or one only observed. */
export function gateObservationOf(
  verdict: GateVerdict,
  call: {
    readonly taskId: string;
    readonly callId: string;
    readonly effect: ToolEffect;
    readonly sink?: ToolSink | undefined;
    readonly at: string;
  },
): GateObservation | undefined {
  // The taint step's asks only: a skill ceiling's is no taint observation.
  const gateReason = [verdict.gateReason, verdict.observedGateReason].find(isTaintGateReason);
  if (gateReason === undefined) return undefined;
  return {
    taskId: call.taskId,
    callId: call.callId,
    toolId: verdict.toolId,
    effect: call.effect,
    ...(call.sink === undefined ? {} : { sink: call.sink }),
    decisionEnforced: verdict.decision,
    decisionObserved: "ask",
    gateReason,
    createdAt: call.at,
  };
}

/**
 * `tavi doctor`'s taint line: "taint would have asked N calls in 7 days (top
 * tools …)" under `observe`, "taint asked …" under `enforce`, and under
 * `off` what it asked or observed before it was turned off.
 */
export function taintDoctorLine(mode: TaintMode, summary: GateObservationSummary, days: number = GATE_OBSERVATION_DOCTOR_DAYS): string {
  const verb = mode === "enforce" ? "taint asked" : "taint would have asked";
  const calls = `${summary.calls} ${summary.calls === 1 ? "call" : "calls"} in ${days} days`;
  const top =
    summary.topTools.length === 0 ? "" : ` (top tools ${summary.topTools.map((tool) => `${tool.toolId} ${tool.calls}`).join(", ")})`;
  const off = mode === "off" ? "; security.taint is off, so nothing is recorded now" : "";
  return `${verb} ${calls}${top}${off}`;
}

/** Most URLs a verdict records for a novel-url ask: what an approval adds to the known set. */
const MAX_VERDICT_URLS = 16;

export const GateVerdictSchema = z.strictObject({
  /**
   * The status of each form row's source as the gate checked it before the
   * round (`checkSources`), in the call's row
   * order: checkpointed with the verdict, so the card shows the checked value.
   */
  sourceChecks: z.array(SourceStatusSchema).max(512).optional(),
  bindingHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  toolId: z.string().min(1).max(128),
  decision: ToolRuleDecisionSchema,
  /** The rule or grant that decided, when one did; `hard-deny` for the built-in list. */
  ruleId: z.string().min(1).max(128).optional(),
  /** Why a `deny` was reached; the model reads it. */
  reason: z.string().max(500).optional(),
  risk: z.strictObject({
    level: RiskLevelSchema,
    reasons: z.array(z.string().max(300)).max(16),
    /** The conversation holds output from a tool that returns untrusted content: `label.integrity === "untrusted"` when the label is present. */
    tainted: z.boolean(),
    /**
     * Set when taint alone made the call high: its own risk and every other
     * raise were below high. What a card names as the reason it is high.
     */
    raisedByTaint: z.literal(true).optional(),
    /**
     * The context's label when the call was emitted: its sources,
     * principals, confidentiality and newest refs, bounded
     * to 4 KiB (`labelSummary`). Absent on a verdict decided without a label.
     */
    label: LabelSummarySchema.optional(),
  }),
  allowedScopes: z.array(ApprovalScopeSchema).min(1).max(3),
  display: ApprovalDisplaySchema,
  /** The call's rule subjects, from which a `session` or `always` decision derives its matcher. */
  subjects: z.array(z.string().max(4_000)).max(32).optional(),
  /** What a `session` decision stores for each subject, when it covers more than the subject (`CallAssessment.sessionMatchers`). */
  sessionMatchers: z.array(ArgMatcherSchema).max(64).optional(),
  /** The tools a `session` or `always` decision covers as one permission (`CallAssessment.scopeGroup`). */
  scopeGroup: ToolPatternSchema.optional(),
  /**
   * With `scopeGroup`: the hosts a wider decision on this call allows the group
   * on — a URL-only call's destinations, or the page (and frames) it acts on
   * (`CallAssessment.scopeHost`, `additionalHosts`). Absent: it named none.
   */
  scopeHosts: z.array(z.string().max(4_000)).max(32).optional(),
  /**
   * Without `scopeGroup`: the hosts the call was decided on
   * (`CallAssessment.scopeHost`, `additionalHosts`), which it is held to when it runs. It scopes
   * no grant. Absent: it named none.
   */
  decidedHosts: z.array(z.string().max(4_000)).max(32).optional(),
  /** See `CallAssessment.contentHash`. */
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** The taint step (or the skill ceiling) asked this call, and why: a person decides it once, and nothing else lifts it. */
  gateReason: GateReasonSchema.optional(),
  /** An `outside-skill-ceiling` ask's ceiling: the skills in scope and what they declared, for the card and a refusal. */
  skillCeiling: SkillCeilingSchema.optional(),
  /**
   * Under `security.taint = observe`: what the taint step would have asked,
   * while the decision stayed as it was without it — recorded, never enforced.
   */
  observedGateReason: GateReasonSchema.optional(),
  /**
   * The assessor set `CallAssessment.askWhenTainted`: carried to the approval
   * request so a schedule fire can deny the call when the chat is tainted.
   */
  askWhenTainted: z.literal(true).optional(),
  /** The assessor set `CallAssessment.attendedOnly`: carried to the approval request so no unattended run answers it. */
  attendedOnly: z.literal(true).optional(),
  /** A `novel-url` ask's URLs, normalized: a person's approval of the call makes them known for the rest of the task. */
  urls: z.array(z.string().min(1).max(KNOWN_URL_LIMITS.maxUrlLength)).max(MAX_VERDICT_URLS).optional(),
  /**
   * The call's effect when its assessment raised it past the tool's
   * (`CallAssessment.effect`): checkpointed with the verdict, and with the
   * pending request, so dispatch, its ledger and a recovered approval use the
   * effect that was decided, whatever changed since. Absent: the tool's own.
   */
  effect: ToolEffectSchema.optional(),
  /**
   * Where the call's strings appear in the checkpointed conversation:
   * display only, set on an ask after the decision was made, never read
   * by it. Absent on an older verdict, or one that is not an ask.
   */
  argOrigins: z.array(ArgOriginSchema).max(ARG_PROVENANCE_LIMITS.maxOrigins).optional(),
});
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/**
 * Why a call is asked, and from where: what an approval
 * request entry carries for the card — the taint step's reason, the context
 * label's sources, principals and newest refs (≤ 5), and where the call's
 * strings appear (≤ 16). Additive and optional on every entry and event: a
 * client that does not know it strips it (`z.object`).
 */
export const ApprovalProvenanceSchema = z.object({
  gateReason: GateReasonSchema.optional(),
  /** With `outside-skill-ceiling`: the skills whose `allowed-tools` the call falls outside. */
  skillCeiling: SkillCeilingSchema.optional(),
  sources: LabelSummarySchema.shape.sources,
  principals: LabelSummarySchema.shape.principals,
  refs: LabelSummarySchema.shape.refs,
  argOrigins: z.array(ArgOriginSchema).max(ARG_PROVENANCE_LIMITS.maxOrigins),
});
export type ApprovalProvenance = z.infer<typeof ApprovalProvenanceSchema>;

/**
 * A verdict's provenance for its request entry: undefined when it has nothing
 * to say — no taint-step reason, a trusted (or absent) label, and no string
 * found anywhere.
 */
export function approvalProvenanceOf(
  verdict: Pick<GateVerdict, "gateReason" | "risk" | "argOrigins" | "skillCeiling">,
): ApprovalProvenance | undefined {
  const label = verdict.risk.label?.integrity === "untrusted" ? verdict.risk.label : undefined;
  const origins = verdict.argOrigins ?? [];
  if (verdict.gateReason === undefined && label === undefined && origins.length === 0) return undefined;
  return {
    ...(verdict.gateReason === undefined ? {} : { gateReason: verdict.gateReason }),
    ...(verdict.skillCeiling === undefined ? {} : { skillCeiling: verdict.skillCeiling }),
    sources: label === undefined ? [] : [...label.sources],
    principals: label === undefined ? [] : [...label.principals],
    refs: label === undefined ? [] : label.refs.slice(0, CONTENT_LABEL_LIMITS.summaryRefs),
    argOrigins: origins.slice(0, ARG_PROVENANCE_LIMITS.maxOrigins),
  };
}

/** A standing grant for the rest of one task, created by a `session` decision. */
export const SessionGrantSchema = z.strictObject({
  grantId: IdSchema,
  taskId: IdSchema,
  workspaceId: z.string().min(1).max(128),
  toolId: ToolIdSchema,
  argMatcher: ArgMatcherSchema.optional(),
  bindingHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** The approval row whose decision created it. */
  approvalId: z.string().min(1).max(200),
  createdBy: z.string().min(1).max(128),
  createdAt: z.string().min(1).max(64),
  /**
   * When it lapses: a grant in a Home or a conversation's chat ends
   * after 24 hours, or at the chat's next epoch, whichever comes first.
   * Absent: it lasts the chat's life, as in a side chat or a run.
   */
  expiresAt: z.string().min(1).max(64).optional(),
});
export type SessionGrant = z.infer<typeof SessionGrantSchema>;

/** How long a grant made in a chat that never ends lasts. */
export const LASTING_CHAT_GRANT_MS = 24 * 60 * 60 * 1000;

/** Durable rules and session grants. */
interface ToolPolicyRepositoryPortDefinition {
  listRules(workspaceId: string): readonly ToolRule[];
  getRule(workspaceId: string, ruleId: string): ToolRule | undefined;
  /** Insert or replace by `ruleId`. */
  putRule(rule: ToolRule): ToolRule;
  deleteRule(workspaceId: string, ruleId: string): boolean;
  /**
   * Store a rule the owner seeds into a workspace, once: the seed is recorded
   * with it, so a rule the operator revoked is never seeded again. True when
   * this call stored it.
   */
  seedRule(rule: ToolRule, at: string): boolean;
  listSessionGrants(taskId: string): readonly SessionGrant[];
  listSessionGrantsForWorkspace(workspaceId: string): readonly SessionGrant[];
  addSessionGrant(grant: SessionGrant): SessionGrant;
  revokeSessionGrant(workspaceId: string, grantId: string): boolean;
  /** Drop every grant of a task; returns how many were removed. */
  clearSessionGrants(taskId: string): number;
  /** Drop every grant of these tools, in every task and workspace (an MCP tool's drift); returns how many were removed. */
  deleteSessionGrantsForTools(toolIds: readonly string[]): number;
  /**
   * Drop every grant whose `expiresAt` is at or before `at`: the owner's
   * sweep, so a lapsed grant of a chat nobody reads again
   * does not stay on disk. Returns how many were removed.
   */
  deleteExpiredSessionGrants(at: string): number;
  /**
   * Drop every grant of the workers recorded under `rootTaskId`'s delegation
   * tree, at any depth: a chat's rollover ends its
   * workers' grants with its own. Read by the rows' root, so a worker recorded
   * before roots were is not reached. Returns how many were removed.
   */
  clearTreeSessionGrants(workspaceId: string, rootTaskId: string): number;
  /**
   * Record one call the taint step asked or would have asked. Idempotent
   * on the task and call: a resumed generation that judges its calls again
   * records nothing new. True when this call stored it.
   */
  recordGateObservation(observation: GateObservation): boolean;
  /** Drop every observation recorded before `at` (the 30-day retention); returns how many. */
  deleteGateObservationsBefore(at: string): number;
  /** The observations recorded at or after `since`, counted, with the `top` most observed tools. */
  summarizeGateObservations(since: string, top: number): GateObservationSummary;
}

export type ToolPolicyRepositoryPort = AsyncRepository<ToolPolicyRepositoryPortDefinition>;

/**
 * Shipped defaults. Every one of them can be overridden by an operator deny or
 * ask rule, because deny and ask are evaluated before allow.
 *
 * - `messaging.send` replies only into the conversation the task was admitted
 *   from — its destination is fixed at admission, never model-chosen — so a
 *   chat-started task can answer without a round.
 * - `operator.ask_user` puts a question in front of the operator; gating it
 *   behind a round asked the operator to approve being asked.
 * - A browser form submit, upload or download asks every time: allowing "the
 *   browser" covers reading and clicking through sites, not sending the task's
 *   data somewhere, which an ask rule keeps ahead of every grant and rule. An
 *   Enter key that can submit a form carries the subject `submit` too.
 * - `browser.vision_act` asks every time:
 *   it matches `browser.*`, but acting by sight it can press anything on the
 *   page, so allowing "the browser" never allows it.
 */
export const SHIPPED_TOOL_RULES: readonly ToolRule[] = [
  {
    ruleId: "shipped-sandbox-readonly",
    workspaceId: "*",
    toolPattern: "sandbox.run",
    decision: "allow",
    readOnly: true,
    source: "shipped",
    createdBy: "tavi",
    createdVia: "config",
    createdAt: "2026-10-31T00:00:00.000Z",
    note: "Commands that only read inside the working folder and print (ls, cat, rg, git status, git diff, …)",
  },
  {
    ruleId: "shipped-messaging-send",
    workspaceId: "*",
    toolPattern: "messaging.send",
    decision: "allow",
    source: "shipped",
    createdBy: "tavi",
    createdVia: "config",
    createdAt: "2026-09-27T00:00:00.000Z",
    note: "Replies go only to the conversation the task came from",
  },
  {
    ruleId: "shipped-ask-user",
    workspaceId: "*",
    toolPattern: "operator.ask_user",
    decision: "allow",
    source: "shipped",
    createdBy: "tavi",
    createdVia: "config",
    createdAt: "2026-09-27T00:00:00.000Z",
    note: "Asking the operator needs no approval of its own",
  },
  {
    ruleId: "shipped-browser-vision",
    workspaceId: "*",
    toolPattern: "browser.vision_act",
    decision: "ask",
    source: "shipped",
    createdBy: "tavi",
    createdVia: "config",
    createdAt: "2026-10-08T00:00:00.000Z",
    note: "Acting in the browser by sight is asked about each time, even when the browser is allowed",
  },
  ...(["submit", "upload", "download"] as const).map(
    (kind): ToolRule => ({
      ruleId: `shipped-browser-${kind}`,
      workspaceId: "*",
      toolPattern: "browser.act",
      argMatcher: kind,
      decision: "ask",
      source: "shipped",
      createdBy: "tavi",
      createdVia: "config",
      createdAt: "2026-09-27T00:00:00.000Z",
      note: `A browser ${kind} is asked about each time, even when the browser is allowed`,
    }),
  ),
];

/** The rule id of the allow rule every workspace is seeded with for the reminder tools. */
export const REMINDER_ALLOW_RULE_ID = "seeded-reminders";
export const REMINDER_ALLOW_RULE_NOTE =
  "Reminders need no approval: they say something at a time, or start a task that asks for its own tools. Remove it to be asked each time.";

/**
 * The allow rule for `reminders.*` the owner seeds into a workspace:
 * a stored operator rule, so Settings → Permissions shows it and can revoke
 * it, and never one a page creates.
 */
export function seededReminderRule(workspaceId: string, createdAt: string): ToolRule {
  return {
    ruleId: REMINDER_ALLOW_RULE_ID,
    workspaceId,
    toolPattern: "reminders.*",
    decision: "allow",
    source: "operator",
    createdBy: "tavi",
    createdVia: "config",
    createdAt,
    note: REMINDER_ALLOW_RULE_NOTE,
  };
}

/** The rule id of the allow rule every workspace is seeded with for the to-do tools. */
export const TODO_ALLOW_RULE_ID = "seeded-todos";
export const TODO_ALLOW_RULE_NOTE =
  "Your own to-do list needs no approval: adding, ticking off and changing to-dos stays in Tavi. Remove it to be asked each time.";

/**
 * The allow rule for `todos.*` the owner seeds into a workspace, once, as the
 * reminders' rule is: the person's own list never asks. A change or a removal
 * made while the chat holds untrusted content still asks (`askWhenTainted`).
 */
export function seededTodoRule(workspaceId: string, createdAt: string): ToolRule {
  return {
    ruleId: TODO_ALLOW_RULE_ID,
    workspaceId,
    toolPattern: "todos.*",
    decision: "allow",
    source: "operator",
    createdBy: "tavi",
    createdVia: "config",
    createdAt,
    note: TODO_ALLOW_RULE_NOTE,
  };
}

export const WEB_SEARCH_ALLOW_RULE_ID = "seeded-web-search";
export const WEB_SEARCH_ALLOW_RULE_NOTE =
  "Web searches need no approval: a query goes to your search provider. A query shaped like a secret (a key or token) still asks, in any chat; a chat holding untrusted content still asks before a search that could carry private data out, or a query shaped like a link or a code. Remove it to be asked each time.";

/**
 * The allow rule for `web_search` the owner seeds into a workspace, once, as
 * the reminders' rule is: revocable in Settings → Permissions, and never put
 * back once revoked. The taint step runs before allow rules, so a tainted
 * chat holding private data still asks (`private-search`), and the search
 * assessor marks a query shaped like data leaving (`assessWebSearch`)
 * `askWhenTainted`, which no rule answers in a tainted chat, and a query shaped
 * like a secret `attendedOnly`, which no rule answers in any chat.
 */
export function seededWebSearchRule(workspaceId: string, createdAt: string): ToolRule {
  return {
    ruleId: WEB_SEARCH_ALLOW_RULE_ID,
    workspaceId,
    toolPattern: "web_search",
    decision: "allow",
    source: "operator",
    createdBy: "tavi",
    createdVia: "config",
    createdAt,
    note: WEB_SEARCH_ALLOW_RULE_NOTE,
  };
}

/** The rule ids of the allow rules every workspace is seeded with for the proposal tools. */
export const MEMORY_PROPOSE_ALLOW_RULE_ID = "seeded-memory-propose";
export const SKILLS_PROPOSE_ALLOW_RULE_ID = "seeded-skills-propose";
export const PROPOSAL_ALLOW_RULE_NOTE =
  "A proposal needs no approval: it only files a suggestion, and its card is where you keep or discard it. Remove it to be asked each time.";

/**
 * The allow rules for `memory.propose` and `skills.propose` the owner seeds
 * into a workspace, once each, as the reminders' rule is: revocable in
 * Settings → Permissions, and never put back once revoked. A proposal is never
 * in force until a person keeps it, so the memory or skill card is the review;
 * the call itself is not asked about.
 */
export function seededProposalRules(workspaceId: string, createdAt: string): readonly ToolRule[] {
  const rule = (ruleId: string, toolPattern: string): ToolRule => ({
    ruleId,
    workspaceId,
    toolPattern,
    decision: "allow",
    source: "operator",
    createdBy: "tavi",
    createdVia: "config",
    createdAt,
    note: PROPOSAL_ALLOW_RULE_NOTE,
  });
  return [rule(MEMORY_PROPOSE_ALLOW_RULE_ID, "memory.propose"), rule(SKILLS_PROPOSE_ALLOW_RULE_ID, "skills.propose")];
}

/** The `decidedBy` of a decision made for everything unseen: `tavi run --approval approve`. */
export function automaticDecider(principalId: string): string {
  return `auto:${principalId}`.slice(0, 128);
}

/**
 * Whether a decision was made by policy rather than by a person who saw the
 * call: a schedule's tool policy, the workflow's own refusal, or a blanket
 * `--approval approve`. Such a decision runs the call, but it is not a person
 * allowing what a model-authored destination reaches.
 */
export function isAutomaticDecider(decidedBy: string): boolean {
  return decidedBy === "policy" || decidedBy.startsWith("schedule:") || decidedBy.startsWith("auto:");
}

/** `serve --allow <tool>` exemptions, as the `flag` rules the gate evaluates and `permissions` lists. */
export function flagAllowRules(toolIds: readonly string[]): readonly ToolRule[] {
  return toolIds.map((toolId) => ({
    ruleId: `flag-allow-${toolId}`,
    workspaceId: "*",
    toolPattern: toolId,
    decision: "allow" as const,
    source: "flag" as const,
    createdBy: "operator",
    createdVia: "config" as const,
    createdAt: "1970-01-01T00:00:00.000Z",
    note: "serve --allow",
  }));
}

/**
 * The id prefix of the rules a Connected apps page stores owner-wide, at
 * workspace `*`: one per tool, the
 * page's own, and the only stored rules that name no workspace.
 */
export const OWNER_WIDE_RULE_PREFIX = "apps-";

/**
 * Rules read from several workspaces, each once: every workspace's list also
 * holds the owner-wide ones.
 */
export function uniqueRules(rules: readonly ToolRule[]): readonly ToolRule[] {
  return [...new Map(rules.map((rule) => [`${rule.workspaceId}\u0000${rule.ruleId}`, rule])).values()];
}

/** Whether a tool id matches a rule's pattern. */
export function toolPatternMatches(pattern: string, toolId: string): boolean {
  if (pattern === "*") return true;
  if (pattern === "web_*") return toolId === "web_search" || toolId === "web_fetch";
  const want = pattern.split(".");
  const have = toolId.split(".");
  if (want.length !== have.length) return false;
  return want.every((segment, index) => segment === "*" || segment === have[index]);
}

const ANY_ONE = Symbol("any-one");
const ANY_RUN = Symbol("any-run");

/**
 * Anchored glob: `*` any run (including none), `?` one character, `\\` makes
 * the next character literal, everything else is literal.
 *
 * Matched by a linear two-pointer walk rather than a compiled regex: `*` as a
 * backtracking `[\s\S]*` made `*a*a*a*a*a*a*a*a*b` against a 60-character
 * subject take over a minute on the gate's synchronous path. On a mismatch the
 * walk returns to the last `*` and lets it absorb one more character — earlier
 * stars never need revisiting, since a later star can absorb anything they
 * could — so the cost is O(glob × subject) at worst. Characters are UTF-16
 * units, as the regex (without the `u` flag) counted them.
 */
export function globMatches(glob: string, subject: string): boolean {
  // Tokens: a literal character, ANY_ONE (`?`) or ANY_RUN (`*`).
  const tokens: (string | typeof ANY_ONE | typeof ANY_RUN)[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "\\" && index + 1 < glob.length) {
      index += 1;
      tokens.push(glob[index]!);
    } else if (char === "*") tokens.push(ANY_RUN);
    else if (char === "?") tokens.push(ANY_ONE);
    else tokens.push(char);
  }
  let at = 0;
  let token = 0;
  let starToken = -1;
  let starAt = 0;
  while (at < subject.length) {
    const current = tokens[token];
    if (current === ANY_RUN) {
      starToken = token;
      starAt = at;
      token += 1;
    } else if (current !== undefined && (current === ANY_ONE || current === subject[at])) {
      token += 1;
      at += 1;
    } else if (starToken >= 0) {
      token = starToken + 1;
      starAt += 1;
      at = starAt;
    } else {
      return false;
    }
  }
  while (tokens[token] === ANY_RUN) token += 1;
  return token === tokens.length;
}

/** A glob that matches exactly this subject and nothing else. */
export function escapeGlob(subject: string): string {
  return subject.replace(/[\\*?]/g, "\\$&");
}

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(...levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((worst, level) => (RISK_ORDER[level] > RISK_ORDER[worst] ? level : worst), "low");
}

/** The scopes a decision at this risk may carry: `always` never outlives a risky or tainted call (`evaluateGate` widens this for an `alwaysAnyCall` call). */
export function scopesForRisk(level: RiskLevel, tainted: boolean): readonly ApprovalScope[] {
  if (level === "critical") return ["once"];
  if (level === "high" || tainted) return ["once", "session"];
  return ["once", "session", "always"];
}

const EFFECT_RISK: Readonly<Record<ToolEffect, RiskLevel>> = { "read-only": "low", mutating: "medium", external: "medium" };

const EFFECT_RANK: Readonly<Record<ToolEffect, number>> = { "read-only": 0, mutating: 1, external: 2 };

/** A call's effect: the tool's declared one, raised by its assessment, never lowered. */
export function effectiveEffect(declared: ToolEffect, assessed?: ToolEffect): ToolEffect {
  return assessed !== undefined && EFFECT_RANK[assessed] > EFFECT_RANK[declared] ? assessed : declared;
}

export interface GateEvaluationInput {
  readonly toolId: string;
  readonly effect: ToolEffect;
  /** `undefined` when the tool declares no assessor or the input did not validate. */
  readonly assessment?: CallAssessment;
  readonly rules: readonly ToolRule[];
  readonly sessionGrants: readonly SessionGrant[];
  /** The effects that ask when nothing else decides (`approvalRequiredFor`). */
  readonly gatedEffects: ReadonlySet<ToolEffect>;
  /** The context's integrity. With `label`, the verdict's taint is the label's, raised to untrusted when this is set. */
  readonly tainted: boolean;
  /**
   * The context label the call was emitted under. When present the
   * verdict's `risk.tainted` is derived from it and `risk.label` summarizes it;
   * it never lowers `tainted` (a trusted label with `tainted` joins `UNTRUSTED_UNKNOWN_SOURCE`).
   */
  readonly label?: ContentLabel | undefined;
  /** How the task was started; a rule with an `origin` applies only to its own, and an `ipc` rule also to `web`. */
  readonly origin?: string | null | undefined;
  /**
   * The channel this turn's admission arrived through, when it differs from
   * how the task was started — `messaging` for a turn sent from a messaging
   * conversation. Never widens: see `ruleAppliesToTurn`.
   */
  readonly channel?: string | null | undefined;
  /**
   * The front end this turn was typed in on the owner's local connection —
   * `web` or `ipc` (`InvocationContext.frontEnd`). Never
   * widens, as `channel`.
   */
  readonly frontEnd?: string | null | undefined;
  /** The tool's static sink (`ToolDefinition.sink`); a call's assessment may narrow it. Absent: the taint step does not apply. */
  readonly sink?: ToolSink | undefined;
  /** The tool's static `urlOnly`. */
  readonly urlOnly?: boolean | undefined;
  /** Absent: `enforce`. */
  readonly taintMode?: TaintMode | undefined;
  /**
   * The URLs known in this task: normal forms (`normalizeUrl`), and the
   * navigation keys of those seen with a fragment (`extractFragmentUrls`).
   * Absent: none is known.
   */
  readonly knownUrls?: ReadonlySet<string> | undefined;
  /** A person approved the signed-in browser earlier in this task (`signed-in-browser`): it does not ask again. */
  readonly signedInBrowserApproved?: boolean | undefined;
  /**
   * The person's own words in this chat (`personTexts`): a browser page
   * whose path they wrote is theirs to open (`personPathOn`). Absent: none.
   */
  readonly personTexts?: readonly string[] | undefined;
  /**
   * The `allowed-tools` ceiling of the skills loaded this turn
   * (`skillCeilingOf`). Absent: none in force. It only ever asks.
   */
  readonly skillCeiling?: SkillCeiling | undefined;
}

/** Whether a rule applies to a task of this origin: an `ipc` rule covers `web` too. */
export function ruleAppliesTo(rule: ToolRule, origin: string | null | undefined): boolean {
  return rule.origin === undefined || originCovers(rule.origin, origin);
}

/**
 * Whether a rule applies to a turn of a task of `origin` that arrived through
 * `channel` and was typed in `frontEnd`: the
 * narrowest of them. A deny or ask rule applies when it covers any — so a turn
 * sent from a messaging conversation is held to the messaging profile, and a
 * turn typed in the canvas to `web` rules, whatever started its task — and an
 * allow rule only when it covers all, so following the turn can never lift
 * what the task's own origin was held to. Neither is the task's origin alone.
 */
export function ruleAppliesToTurn(
  rule: ToolRule,
  origin: string | null | undefined,
  channel: string | null | undefined,
  frontEnd?: string | null | undefined,
): boolean {
  const turn = [channel, frontEnd].filter((entry): entry is string => entry !== undefined && entry !== null && entry !== origin);
  if (turn.length === 0) return ruleAppliesTo(rule, origin);
  return rule.decision === "allow"
    ? ruleAppliesTo(rule, origin) && turn.every((entry) => ruleAppliesTo(rule, entry))
    : ruleAppliesTo(rule, origin) || turn.some((entry) => ruleAppliesTo(rule, entry));
}

/** A matcher-less entry matches every call of its tool; a matcher needs subjects to match. */
function matchesAny(matcher: string | undefined, subjects: readonly string[]): boolean {
  return matcher === undefined || subjects.some((subject) => globMatches(matcher, subject));
}

/**
 * A spelling a folding filesystem (APFS, NTFS) opens as the same name, for
 * refusals: a superset of its case folding, so a refusal may match too much,
 * never too little. Compatibility decomposition maps what lower-casing keeps
 * (U+017F long s to `s`, the Kelvin sign to `K`, fullwidth and ligature
 * letters), and sharp s expands as case folding does.
 */
export const fsFold = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\u00df/g, "ss")
    .normalize("NFKD");

/** `matchesAny` for a deny or ask rule: also case-folded and NFC-normalized when the subjects are paths on a folding filesystem. */
function restricts(matcher: string | undefined, subjects: readonly string[], foldCase: boolean): boolean {
  return matchesAny(matcher, subjects) || (foldCase && matcher !== undefined && matchesAny(fsFold(matcher), subjects.map(fsFold)));
}

/** Allowed only when every subject is covered by some entry; a matcher-less entry covers all. */
function coversAll(matchers: readonly (string | undefined)[], subjects: readonly string[]): boolean {
  if (matchers.length === 0) return false;
  if (matchers.some((matcher) => matcher === undefined)) return true;
  return (
    subjects.length > 0 && subjects.every((subject) => matchers.some((matcher) => matcher !== undefined && globMatches(matcher, subject)))
  );
}

/** The reason a verdict carries when its card text held characters that would hide or reorder what is shown. */
const HIDDEN_CHARACTERS_REASON = "the call's text holds hidden or control characters, shown as ⟨…⟩ marks";

/** The reason a verdict carries when the conversation is tainted; front ends show taint their own way. */
const TAINT_REASON = "the conversation contains untrusted content from the web or a document";

/**
 * The reason an injection-detector hit adds:
 * the card's warning line. What follows the prefix names the source and what
 * the detector saw.
 */
export const INJECTION_WARNING_PREFIX = "possible prompt injection in";

/** A detector hit's reason: `possible prompt injection in <source> content (<signals>)`. */
export function injectionWarningReason(source: string, signals: readonly string[]): string {
  return clipText(`${INJECTION_WARNING_PREFIX} ${source} content (${signals.slice(0, 4).join(", ")})`, 300);
}

/** Whether a verdict reason is a detector hit's (`injectionWarningReason`). */
export function isInjectionWarning(reason: string): boolean {
  return reason.startsWith(`${INJECTION_WARNING_PREFIX} `);
}

/**
 * `verdict` with a detector hit's reasons: each added once, and
 * its risk raised to `high` if it was lower. Raise-only by construction:
 * the decision, its rule, the scopes offered, the taint-step reason and
 * everything else are the verdict's own — a hit never allows, never denies
 * and never lowers anything. A full reasons list gives up its oldest
 * non-warning reasons, so the warning always shows.
 */
export function withInjectionWarning(verdict: GateVerdict, reasons: readonly string[]): GateVerdict {
  const added = reasons.filter((reason) => !verdict.risk.reasons.includes(reason));
  if (added.length === 0) return verdict;
  const merged = [...verdict.risk.reasons, ...added];
  // Over the bound, the oldest reasons that are not warnings make room: a hit's warning is never the one cut.
  while (merged.length > 16) {
    const oldest = merged.findIndex((reason) => !isInjectionWarning(reason));
    merged.splice(oldest === -1 ? 16 : oldest, oldest === -1 ? merged.length - 16 : 1);
  }
  // An injection hit raises the call on its own: taint is no longer the only reason it is high.
  const { raisedByTaint: _raised, ...risk } = verdict.risk;
  return { ...verdict, risk: { ...risk, level: maxRisk(verdict.risk.level, "high"), reasons: merged } };
}

/** Whether a verdict reason is the taint reason, which front ends show as their own line. */
export function isTaintReason(reason: string): boolean {
  return reason === TAINT_REASON;
}

/** What an unattended run reads of one approval request entry to decide whether its own policy may answer it. */
export interface UnattendedRequestFacts {
  readonly gateReason?: GateReason | undefined;
  readonly tainted?: boolean | undefined;
  readonly askWhenTainted?: boolean | undefined;
  readonly attendedOnly?: boolean | undefined;
  readonly risk?: { readonly level: RiskLevel; readonly tainted?: boolean } | undefined;
  /** An `outside-skill-ceiling` ask's ceiling: on a verdict itself, or on a request entry's provenance. */
  readonly skillCeiling?: SkillCeilingSummary | undefined;
  readonly provenance?: { readonly skillCeiling?: SkillCeilingSummary | undefined } | undefined;
}

/**
 * Why a run nobody attends (a schedule fire, `tavi run --approval approve`) must
 * deny this call, whatever its `autoApproveTools` or approve-all: the taint step or a skill
 * ceiling asked it, it is tainted and `askWhenTainted`, it is `attendedOnly`, or it is rated `critical`. Undefined:
 * the run's own policy decides. An entry built before these fields existed
 * still carries `risk`, so its `critical` rating denies it; it has no
 * `askWhenTainted` or `gateReason`, and an entry with no `risk` either is left
 * wholly to the run's policy.
 */
export function unattendedDenial(request: UnattendedRequestFacts): string | undefined {
  if (request.gateReason === "outside-skill-ceiling")
    return `denied: ${skillCeilingRefusal(request.skillCeiling ?? request.provenance?.skillCeiling)} Nobody attends this run to approve it`;
  if (request.gateReason !== undefined)
    return `denied: the chat read untrusted content (${request.gateReason}); nobody attends this run to approve it`;
  const tainted = request.tainted ?? request.risk?.tainted ?? false;
  if (tainted && request.askWhenTainted === true)
    return "denied: the chat read untrusted content, and this tool asks a person then; nobody attends this run to approve it";
  if (request.attendedOnly === true)
    return "denied: a person reviews this call themselves (a form fill, a send shown whole); nobody attends this run";
  if (request.risk?.level === "critical") return "denied: a critical call needs a person; nobody attends this run to approve it";
  return undefined;
}

/**
 * The `schedules.*` and `routines.*` tools that only read. Every other tool of
 * those two families creates, changes, starts or delivers scheduled work, which
 * a schedule's fire never does: a run nobody attends that could schedule more
 * work would grow work no person asked for. Kept equal to the tools' own
 * `effect` by a test over their registrations.
 */
export const SCHEDULING_READ_ONLY_TOOLS: readonly string[] = [
  "schedules.list",
  "schedules.history",
  "routines.get",
  "routines.list",
  "routines.history",
  "routines.inspect",
  "routines.targets",
];

/**
 * Read-only routine tools since folded into `routines.get`'s `view`. A stored list may still name them: they
 * are not writes, so a list re-sent with them is not refused, but they name no tool, so a fire grants nothing by them.
 */
export const RETIRED_SCHEDULING_READS: readonly string[] = ["routines.explain", "routines.verify", "routines.readiness"];

const SCHEDULING_FAMILIES = ["schedules.", "routines."] as const;

const SCHEDULING_WRITE_REFUSAL = "a scheduled run never creates or changes schedules or routines";

/**
 * Whether a schedule tool pattern (a tool id, a `prefix.*` family, or `*`)
 * reaches a tool that creates or changes schedules or routines. A family that
 * covers one of them reaches it, read-only members and all; so does an id of
 * those families that is not a known read-only one, which a later tool could take.
 */
export function reachesSchedulingWrite(pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return SCHEDULING_FAMILIES.some((family) => family.startsWith(prefix) || prefix.startsWith(family));
  }
  return (
    SCHEDULING_FAMILIES.some((family) => pattern.startsWith(family)) &&
    !SCHEDULING_READ_ONLY_TOOLS.includes(pattern) &&
    !RETIRED_SCHEDULING_READS.includes(pattern)
  );
}

/**
 * Why a schedule may not list `pattern`, naming the read-only tools of its
 * family it may list instead; undefined when it may. `*` is left to its own,
 * broader refusal.
 */
export function schedulingPatternRefusal(pattern: string): string | undefined {
  if (pattern === "*" || !reachesSchedulingWrite(pattern)) return undefined;
  const prefix = pattern.endsWith(".*") ? pattern.slice(0, -1) : pattern;
  const families = SCHEDULING_FAMILIES.filter((family) => prefix.startsWith(family) || family.startsWith(prefix));
  const readOnly = SCHEDULING_READ_ONLY_TOOLS.filter((id) => families.some((family) => id.startsWith(family)));
  return `--allow ${JSON.stringify(pattern)} is refused: ${SCHEDULING_WRITE_REFUSAL}; name the read-only ones it may use instead (${readOnly.join(", ")})`;
}

/**
 * Why a schedule's fire denies a call its tool list names: the tool creates or
 * changes schedules or routines. A list saved before such entries were refused
 * still names them; it is left as it is, and only these calls are denied.
 */
export function scheduledWorkDenial(toolName: string): string | undefined {
  return reachesSchedulingWrite(toolName) ? `denied: ${SCHEDULING_WRITE_REFUSAL}, whatever its tool list says` : undefined;
}

/**
 * The `persist` tools the taint step lets through: an explicit memory or
 * skill proposal is filed for a person's review and is never in force until
 * they keep it (allowed, and the proposal marked with where its words came
 * from). A skill offered unasked in such a turn is refused by its handler, so
 * no card is shown for it first.
 */
const PERSIST_ALLOWED_UNDER_TAINT: ReadonlySet<string> = new Set(["memory.propose", "skills.propose"]);

/** What the taint step asks about, and the URLs a `novel-url` ask would make known once a person approves it. */
interface TaintAsk {
  readonly reason: GateReason;
  readonly urls?: readonly string[];
}

/** The origin part (`scheme://host[:port]`) of a normal form or navigation key. */
function originOfKey(key: string): string {
  const at = key.indexOf("/", key.indexOf("//") + 2);
  return at === -1 ? key : key.slice(0, at);
}

/** Whether a session grant on a browser tool ("Allow for this chat" on a site) names `url`'s host. */
function browserGrantCovers(grants: readonly SessionGrant[], url: string): boolean {
  const host = hostAndPathOf(url)?.hostname;
  if (host === undefined || host === "") return false;
  return grants.some(
    (grant) => grant.toolId.startsWith("browser.") && grant.argMatcher !== undefined && globMatches(grant.argMatcher, host),
  );
}

/**
 * Whether `url` is a page of a site `onSite` accepts, with no query or fragment, whose path is the site's root or
 * one the person wrote (`/login`, `/dynamic_loading/2`): an address made only of their words.
 */
function personPathOn(url: string, onSite: (url: string) => boolean, texts: readonly string[] | undefined): boolean {
  const parsed = hostAndPathOf(url);
  if (parsed === undefined || /[?#]/.test(url) || !onSite(url)) return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") return true;
  return path.length <= 512 && (texts ?? []).some((text) => text.includes(path));
}

/**
 * The taint step for one call: what it asks, or `undefined` when it
 * skips. Pure. [B], private data in the context, is the label's
 * confidentiality: it turns a group reply, a search and every
 * browser typing step into an ask. Without a label the
 * context reads as public: [A] alone.
 */
function taintStep(input: GateEvaluationInput, assessment: CallAssessment | undefined): TaintAsk | undefined {
  if (!input.tainted) return undefined;
  // The person's signed-in browser, whatever the page: a signed-out session is the way that never asks.
  if (assessment?.signedInProfile === true && input.signedInBrowserApproved !== true) return { reason: "signed-in-browser" };
  const confidential = input.label !== undefined && input.label.confidentiality !== "public";
  const sink = assessment?.sink ?? input.sink;
  // A tool that declares no sink keeps today's treatment.
  if (sink === undefined) return undefined;
  switch (sink) {
    case "none":
      return undefined;
    // Outbound disarm keeps a reply safe; other members read a group's or topic's, so it
    // asks once when the context holds private data.
    case "reply":
      return confidential && assessment?.groupDestination === true ? { reason: "private-group-reply" } : undefined;
    // A query carries no private data out unless the context holds some.
    case "search":
      return confidential ? { reason: "private-search" } : undefined;
    case "message":
      return { reason: "tainted-message" };
    case "credential":
      return { reason: "credential-under-taint" };
    case "persist":
      return PERSIST_ALLOWED_UNDER_TAINT.has(input.toolId) ? undefined : { reason: "tainted-persist" };
    case "network":
      break;
  }
  const known = input.knownUrls ?? new Set<string>();
  const vouched = new Set(
    (assessment?.vouchedUrls ?? []).flatMap((url) => {
      const normalized = normalizeUrl(url);
      return normalized === undefined ? [] : [normalized];
    }),
  );
  const novel: string[] = [];
  // A URL that does not normalize (over-long, not http(s)) is never known: asked about, with nothing to record.
  let unrecorded = false;
  // A navigation is recorded with its fragment (`navigationKeyOf`), so an approval of it matches it next time.
  const noteNovel = (url: string, navigation = false): void => {
    const key = navigation ? navigationKeyOf(url) : normalizeUrl(url);
    if (key === undefined || key.length > KNOWN_URL_LIMITS.maxUrlLength) unrecorded = true;
    else if (!novel.includes(key)) novel.push(key);
  };
  const novelAsk = (): TaintAsk | undefined => (novel.length === 0 && !unrecorded ? undefined : { reason: "novel-url", urls: novel });
  let origins: ReadonlySet<string> | undefined;
  const originKnown = (url: string): boolean => {
    origins ??= new Set([...known, ...vouched].map(originOfKey));
    const page = normalizeUrl(url);
    return page !== undefined && origins.has(originOfKey(page));
  };
  const steps = assessment?.browserSteps;
  if (steps !== undefined) {
    // A site the person allowed the browser on for this chat ("Allow for this chat"): its pages they name open.
    const siteAllowed = (url: string): boolean => browserGrantCovers(input.sessionGrants, url);
    let payload = false;
    for (const step of steps) {
      if (step.kind === "inert") continue;
      // A submit, upload, download or committing press carries what the page holds out under taint: its
      // shipped ask rule asks once in an attended chat, and a run nobody attends must refuse it.
      if (step.kind === "send") {
        payload = true;
        continue;
      }
      if (step.kind === "navigate") {
        // The fragment counts: page script reads it (`isKnownNavigation`). A fragment on a known
        // page is not known either: the call asks, with the address and its fragment recorded.
        if (step.url === undefined) unrecorded = true;
        else if (
          !isKnownNavigation(step.url, known) &&
          !isKnownNavigation(step.url, vouched) &&
          // A page of an allowed or seen site by a path the person wrote, with no query or fragment: its
          // address is the site and the person's words as they wrote them, with nothing composed into it.
          !personPathOn(step.url, (url) => siteAllowed(url) || originKnown(url), input.personTexts)
        )
          noteNovel(step.url, true);
        continue;
      }
      // Typing under [A] alone: allowed on an origin a known URL names. A page the tool cannot
      // name (none observed yet, or forgotten) is not established: it asks, failing safe.
      // Under [A]∧[B] every typing step asks: page script reads keystrokes without a submit.
      if (confidential || step.url === undefined) {
        payload = true;
        continue;
      }
      if (!originKnown(step.url)) payload = true;
    }
    return payload ? { reason: "tainted-payload" } : novelAsk();
  }
  const urlOnly = assessment?.urlOnly ?? input.urlOnly ?? false;
  if (!urlOnly) return { reason: "tainted-payload" };
  // A urlOnly call whose URLs were not read (no assessor, or one that failed) is never known.
  if (assessment?.urls === undefined) return { reason: "novel-url" };
  for (const url of assessment.urls) {
    if (!isKnownUrl(url, known) && !isKnownUrl(url, vouched)) noteNovel(url);
  }
  return novelAsk();
}

/** Decide one call. Pure: the caller supplies the rules and grants in force when the call was emitted. */
export function evaluateGate(given: GateEvaluationInput): GateVerdict {
  // The label, when given, only raises the taint: `risk.tainted` always agrees with `risk.label`.
  const label =
    given.label === undefined
      ? undefined
      : given.tainted && !isUntrusted(given.label)
        ? joinLabels(given.label, UNTRUSTED_UNKNOWN_SOURCE)
        : given.label;
  const labelled: GateEvaluationInput = label === undefined ? given : { ...given, label, tainted: isUntrusted(label) };
  // The call's effect, raised by its assessment: the gate decides by it, and the verdict keeps it.
  const effect = effectiveEffect(labelled.effect, labelled.assessment?.effect);
  const input: GateEvaluationInput = effect === labelled.effect ? labelled : { ...labelled, effect };
  const assessment = input.assessment;
  const subjects = assessment?.subjects ?? [];
  const reasons = [...(assessment?.reasons ?? [])];
  if (input.tainted) reasons.push(TAINT_REASON);
  // A card that would hide part of what is approved — a terminal control, a bidi override, an invisible
  // character — is shown with each one marked, says so, and is asked about as high risk.
  const hides = displayHides(assessment?.display, assessment?.reasons ?? []);
  if (hides) reasons.push(HIDDEN_CHARACTERS_REASON);
  const ownLevel = maxRisk(assessment?.risk ?? EFFECT_RISK[input.effect], hides ? "high" : "low");
  const level = maxRisk(ownLevel, input.tainted ? "high" : "low");
  // Clipped to the verdict schema's bounds here, whatever the assessor sent: a
  // title or reason carrying a 4,096-character path would otherwise make the
  // checkpointed verdict fail to parse and strand the task.
  const risk = {
    level,
    reasons: reasons.slice(0, 16).map((reason) => cardText(reason, 300)),
    tainted: input.tainted,
    ...(input.tainted && RISK_ORDER[ownLevel] < RISK_ORDER.high ? { raisedByTaint: true as const } : {}),
    ...(input.label === undefined ? {} : { label: labelSummary(input.label) }),
  };
  const display = clipDisplay(assessment?.display, input.toolId);
  // A wider scope stores matchers built from the subjects, so it is offered
  // only when each subject fits a matcher whole: a clipped matcher would allow
  // a different call from the one shown. With no subjects, `session` covers
  // any call of the tool in this task, and `always` — a standing rule for any
  // call of the tool — is not offered, unless the assessor sets `alwaysAnyCall`:
  // then it is, whatever the taint, at the assessor's own risk. The
  // subjects are recorded whenever the verdict's schema holds them, so a
  // handler can check its target against what was decided.
  const recordable = subjects.length <= 32 && subjects.every((subject) => subject.length <= 4_000);
  const representable = recordable && subjects.every((subject) => escapeGlob(subject).length <= 512);
  const riskScopes = scopesForRisk(level, input.tainted);
  // A grouped call is decided for the group as a whole, so its subjects neither
  // narrow a wider scope nor keep `always` from being offered.
  const scopeGroup =
    assessment?.scopeGroup !== undefined &&
    ToolPatternSchema.safeParse(assessment.scopeGroup).success &&
    toolPatternMatches(assessment.scopeGroup, input.toolId)
      ? assessment.scopeGroup
      : undefined;
  // The hosts a grouped decision is for: a URL-only request's destinations, or the page (and frames) the call acts on.
  const nameable = (host: string | undefined): host is string => host !== undefined && host !== "" && escapeGlob(host).length <= 512;
  const otherHosts = (assessment?.additionalHosts ?? []).filter((host) => host !== "" && host !== assessment?.scopeHost);
  const actedHosts = [...new Set([assessment?.scopeHost ?? "", ...otherHosts])];
  // A call on several hosts is decided for every one, or not at all: one a verdict cannot name is never dropped.
  const unnameable = otherHosts.length > 0 && (actedHosts.length > 32 || !actedHosts.every(nameable));
  const namedHosts = unnameable || !nameable(assessment?.scopeHost) ? [] : actedHosts;
  const pageHosts = scopeGroup === undefined || namedHosts.length === 0 ? undefined : namedHosts;
  const decidedHosts = scopeGroup === undefined ? namedHosts : [];
  const destination = input.sink === "network" && input.urlOnly === true;
  const scopeHosts = scopeGroup === undefined ? [] : pageHosts !== undefined ? pageHosts : destination && representable ? subjects : [];
  // A session grant never lifts a call asked about under taint (below), so offering one would be a choice that does nothing.
  const onceOnly = assessment?.onceOnly === true || (input.tainted && assessment?.askWhenTainted === true);
  const anyCall = assessment?.alwaysAnyCall === true && subjects.length === 0;
  const allowedScopes: ApprovalScope[] = onceOnly
    ? ["once"]
    : anyCall
      ? [...scopesForRisk(assessment.risk, false)]
      : scopeGroup !== undefined
        ? [...riskScopes]
        : !representable
          ? ["once"]
          : subjects.length === 0
            ? riskScopes.filter((scope) => scope !== "always")
            : [...riskScopes];
  const base = {
    ...(assessment?.bindingHash === undefined ? {} : { bindingHash: assessment.bindingHash }),
    toolId: input.toolId,
    risk,
    allowedScopes,
    display,
    ...(subjects.length === 0 || !recordable ? {} : { subjects: [...subjects] }),
    // Kept only when they cover every subject they stand for, and each is a matcher a grant can store.
    ...(recordable &&
    subjects.length > 0 &&
    assessment?.sessionMatchers !== undefined &&
    assessment.sessionMatchers.length <= 64 &&
    assessment.sessionMatchers.every((matcher) => matcher.length > 0 && matcher.length <= 512) &&
    coversAll(assessment.sessionMatchers, subjects)
      ? { sessionMatchers: [...assessment.sessionMatchers] }
      : {}),
    ...(scopeGroup === undefined ? {} : { scopeGroup }),
    ...(scopeHosts.length === 0 ? {} : { scopeHosts: [...scopeHosts] }),
    ...(decidedHosts.length === 0 ? {} : { decidedHosts }),
    ...(assessment?.contentHash !== undefined && /^[a-f0-9]{64}$/.test(assessment.contentHash)
      ? { contentHash: assessment.contentHash }
      : {}),
    ...(assessment?.askWhenTainted === true ? { askWhenTainted: true as const } : {}),
    ...(assessment?.attendedOnly === true ? { attendedOnly: true as const } : {}),
    ...(effect === given.effect ? {} : { effect }),
  };

  if (assessment?.hardDeny !== undefined) {
    return { ...base, decision: "deny", ruleId: "hard-deny", reason: assessment.hardDeny.slice(0, 500) };
  }
  if (unnameable) {
    return {
      ...base,
      decision: "deny",
      ruleId: "hard-deny",
      reason: "the call acts on more hosts, or longer ones, than one decision can name: send it in smaller parts",
    };
  }
  const forTool = input.rules.filter(
    (rule) => ruleAppliesToTurn(rule, input.origin, input.channel, input.frontEnd) && toolPatternMatches(rule.toolPattern, input.toolId),
  );
  const aliases = assessment?.ruleAliases ?? [];
  const borrowed =
    aliases.length === 0
      ? []
      : input.rules.filter(
          (rule) =>
            rule.decision !== "allow" &&
            !forTool.includes(rule) &&
            ruleAppliesToTurn(rule, input.origin, input.channel, input.frontEnd) &&
            aliases.some((alias) => toolPatternMatches(rule.toolPattern, alias)),
        );
  const restricting = [...forTool, ...borrowed];
  const foldCase = assessment?.foldCase === true;
  // A deny or ask rule may name the page's host (or a frame's) as well as what the call does.
  const restricted = pageHosts === undefined ? subjects : [...subjects, ...pageHosts];
  // Deny and ask rules also match the call's other spellings (`env curl` as `curl`): they only ever make it stricter.
  const spelled = [...restricted, ...(assessment?.forms ?? []).filter((form) => !restricted.includes(form))];
  const denied = restricting.find((rule) => rule.decision === "deny" && restricts(rule.argMatcher, spelled, foldCase));
  if (denied !== undefined) {
    return {
      ...base,
      decision: "deny",
      ruleId: denied.ruleId,
      reason: `refused by rule ${denied.ruleId}${denied.note === undefined ? "" : ` (${denied.note})`}`.slice(0, 500),
    };
  }
  // The taint step: after the deny rules, before every ask rule, allow rule and grant, so
  // none of them — nor `alwaysAnyCall` — can lift it. Once only: a grant would outlive this call.
  const mode = input.taintMode ?? "enforce";
  const taintAsk = mode === "off" ? undefined : taintStep(input, assessment);
  if (taintAsk !== undefined && mode === "enforce") {
    return {
      ...base,
      risk: {
        ...risk,
        level: maxRisk(level, "high"),
        ...(RISK_ORDER[level] < RISK_ORDER.high ? { raisedByTaint: true as const } : {}),
      },
      allowedScopes: ["once"],
      decision: "ask",
      gateReason: taintAsk.reason,
      ...(taintAsk.urls === undefined || taintAsk.urls.length === 0 ? {} : { urls: taintAsk.urls.slice(0, MAX_VERDICT_URLS) }),
    };
  }
  // The skill ceiling: a call outside the `allowed-tools` of the skills loaded this turn is asked, once,
  // whatever an allow rule or grant says — after every deny, so it never relaxes one, and only ever an ask,
  // which a run nobody attends refuses. Inside the ceiling the call goes on as if there were none.
  if (input.skillCeiling !== undefined && !skillCeilingAllows(input.skillCeiling, input.toolId)) {
    const { tools: _tools, ...skillCeiling } = input.skillCeiling;
    const asked: GateVerdict = {
      ...base,
      allowedScopes: ["once"],
      decision: "ask",
      gateReason: "outside-skill-ceiling",
      skillCeiling,
    };
    return taintAsk === undefined ? asked : { ...asked, observedGateReason: taintAsk.reason };
  }
  // A call only a person decides is asked, once, whatever an allow rule, a grant or the gated effects say: its
  // card is the person's review. An unattended run then denies the ask.
  if (assessment?.attendedOnly === true) {
    const asked: GateVerdict = { ...base, allowedScopes: ["once"], decision: "ask" };
    return taintAsk === undefined ? asked : { ...asked, observedGateReason: taintAsk.reason };
  }
  const verdict = decideByRules(
    input,
    assessment,
    base,
    level,
    restricting,
    forTool,
    restricted,
    spelled,
    foldCase,
    scopeGroup === undefined ? undefined : { hosts: pageHosts, named: scopeHosts.length > 0 },
  );
  // Observed only: the decision is the one the gate makes without the step.
  return taintAsk === undefined ? verdict : { ...verdict, observedGateReason: taintAsk.reason };
}

/** Ask rules → allow rules → session grants → the effect default: the rest of `evaluateGate`. */
function decideByRules(
  input: GateEvaluationInput,
  assessment: CallAssessment | undefined,
  base: Omit<GateVerdict, "decision">,
  level: RiskLevel,
  restricting: readonly ToolRule[],
  forTool: readonly ToolRule[],
  subjects: readonly string[],
  spelled: readonly string[],
  foldCase: boolean,
  grouped?: GroupedCall,
): GateVerdict {
  const asked = restricting.find((rule) => rule.decision === "ask" && restricts(rule.argMatcher, spelled, foldCase));
  // An ask rule is evaluated before every grant, so a wider scope could never
  // take effect: offer only `once`.
  if (asked !== undefined) return { ...base, allowedScopes: ["once"], decision: "ask", ruleId: asked.ruleId };

  // Critical calls are always put in front of a person, whatever a rule says,
  // and so is a call its assessor asks to be asked about under taint.
  const allowable = level !== "critical" && !(input.tainted && assessment?.askWhenTainted === true);
  // A rule saved with a binding hash (an `always` approval) is scoped to that
  // provider binding; one without (`serve --allow`, `permissions add`, `web_*`)
  // applies to whichever binding the call resolves.
  // A grouped call that names a host is never allowed by an approval's rule for any call of the tool: that
  // approval named a host of its own, or none (a rule from before approvals were held to their host).
  // A read-only rule allows what its tool's assessor reads as read-only, and nothing else: never a blanket allow.
  const readOnlyRule = forTool.find((rule) => rule.decision === "allow" && rule.readOnly === true);
  if (allowable && readOnlyRule !== undefined && assessment?.readOnly === true && assessment.unparsed !== true)
    return { ...base, decision: "allow", ruleId: readOnlyRule.ruleId };
  const allowRules = forTool.filter(
    (rule) =>
      rule.decision === "allow" &&
      rule.readOnly !== true &&
      // A call no rule can read is allowed only by a rule written to cover such calls.
      (assessment?.unparsed !== true || rule.matchUnparsed === true) &&
      (rule.bindingHash === undefined || rule.bindingHash === assessment?.bindingHash) &&
      !(grouped?.named === true && rule.argMatcher === undefined && isApprovalRule(rule)),
  );
  // A call that acts on a page is allowed by a rule for its host — every one of them — (or for any call of the tool).
  const allowedSubjects = grouped?.hosts === undefined ? subjects : grouped.hosts;
  const allowedBy = allowRules.find((rule) => rule.argMatcher === undefined) ?? allowRules[0];
  // A grouped call with nothing to match (closing a session) is allowed by any allow rule for its tool, as by any grant.
  const anyRule = grouped !== undefined && grouped.hosts === undefined && subjects.length === 0;
  if (
    allowable &&
    allowedBy !== undefined &&
    (anyRule ||
      coversAll(
        allowRules.map((rule) => rule.argMatcher),
        allowedSubjects,
      ))
  ) {
    return { ...base, decision: "allow", ruleId: allowedBy.ruleId };
  }
  const grants = input.sessionGrants.filter((grant) => grant.toolId === input.toolId && grant.bindingHash === assessment?.bindingHash);
  // A grant is an approval of calls a person was shown; one no rule can read was shown once only.
  const grantedBy = assessment?.unparsed === true ? undefined : groupedGrant(grants, subjects, grouped);
  if (allowable && grantedBy !== undefined) {
    return { ...base, decision: "allow", ruleId: grantedBy.grantId };
  }
  if (input.gatedEffects.has(input.effect) || !allowable) return { ...base, decision: "ask" };
  return { ...base, decision: "allow" };
}

/** A grouped call's hosts (the page it acts on, and any frames on other sites), and whether it names one or a destination at all. */
interface GroupedCall {
  readonly hosts: readonly string[] | undefined;
  readonly named: boolean;
}

/**
 * The grant that covers a call, if one does. A grouped call that acts on a
 * page is covered only by grants for its hosts, every one — a grant for any call of
 * the tool came from a decision that named no host. A grouped call with
 * nothing to match (closing a session) is covered by any grant for its tool.
 * Otherwise every subject must be matched.
 */
function groupedGrant(
  grants: readonly SessionGrant[],
  subjects: readonly string[],
  grouped: GroupedCall | undefined,
): SessionGrant | undefined {
  if (grouped?.hosts !== undefined) {
    const covering = (host: string) => grants.find((grant) => grant.argMatcher !== undefined && globMatches(grant.argMatcher, host));
    return grouped.hosts.every((host) => covering(host) !== undefined) ? covering(grouped.hosts[0] ?? "") : undefined;
  }
  // A destination is covered only by a grant for it: every grant comes from an approval, and one for any call named none.
  if (grouped?.named === true) {
    const named = grants.filter((grant) => grant.argMatcher !== undefined);
    return named.length > 0 &&
      coversAll(
        named.map((grant) => grant.argMatcher),
        subjects,
      )
      ? named[0]
      : undefined;
  }
  if (grouped !== undefined && subjects.length === 0) return grants[0];
  const grantedBy = grants.find((grant) => grant.argMatcher === undefined) ?? grants[0];
  return grantedBy !== undefined &&
    coversAll(
      grants.map((grant) => grant.argMatcher),
      subjects,
    )
    ? grantedBy
    : undefined;
}

/** How an `always` approval's rule note begins (`approve` writes it): a rule a person made by approving a call, not by writing it. */
export const APPROVAL_RULE_NOTE_PREFIX = "approved always in round ";

/** A rule an `always` approval wrote, as opposed to one an operator wrote (`permissions add`, `serve --allow`, config). */
export function isApprovalRule(rule: Pick<ToolRule, "source" | "note" | "fromApproval">): boolean {
  return rule.fromApproval === true || (rule.source === "operator" && rule.note?.startsWith(APPROVAL_RULE_NOTE_PREFIX) === true);
}
