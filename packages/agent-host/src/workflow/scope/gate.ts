import { z } from "zod";
import {
  toolAnnotationsOf,
  isPlumbingOrigin,
  type CallAssessment,
  type GateVerdict,
  maxRisk,
  type SourceCheck,
  type ToolEffect,
  effectiveEffect,
  evaluateGate,
  gateObservationOf,
  isAutomaticDecider,
  isUntrusted,
  type SourceKind,
  injectionWarningReason,
  withInjectionWarning,
  type ContentLabel,
  unattendedDenial,
  scheduledWorkDenial,
  ARG_PROVENANCE_LIMITS,
  approvalProvenanceOf,
  type ApprovalProvenance,
  argumentOrigins,
  provenanceWindow,
  type ProvenanceWindowEntry,
  type AdmissionOutcome,
  type InvocationContext,
  CONTEXT_MESSAGE_PREFIX,
  isPersonMessage,
  isQuotedDataMessage,
  policyAllowsTool,
  readerSessionAllows,
  approvalRowId,
  type RegisteredTool,
  type WorkflowMessage,
  type parseAgentState,
  type ModEnvelope,
  containsRedactionPlaceholder,
  disarmUrls,
  skillCeilingRefusal,
  DESKTOP_HOST_PREFIX,
} from "@tavi/contracts";
import { clip, definedOnly, errorMessage } from "@tavi/contracts/util";
import { stringLeaves, urlKeysOf, personTexts, originKeyOf, knownUrlSetOf, typedPageEntry } from "../known-urls.js";
import type { OfferScope } from "./offer.js";
import { turnSkillCeiling } from "../skill-scope.js";
import { inboundBody } from "../admission-input.js";

/** The most untrusted messages the injection detector reads for one call: the newest. */
const MAX_DETECTOR_ITEMS = 16;

/** What the model is told of a taint-step refusal in a run nobody attends, by reason (a skill ceiling's names its skill). */
const GATE_REASON_REFUSALS: Readonly<Record<Exclude<NonNullable<GateVerdict["gateReason"]>, "outside-skill-ceiling">, string>> = {
  "novel-url": "This chat read untrusted content, and this URL is not one the conversation already holds.",
  "tainted-payload":
    "This chat read untrusted content, and this call would act on a site as the model chose (send, type, upload or download).",
  "tainted-message": "This chat read untrusted content, and this call would send a message to another destination.",
  "credential-under-taint": "This chat read untrusted content, and this call would use a stored credential.",
  "tainted-persist": "This chat read untrusted content, and this call would change something that outlives the chat.",
  "private-search": "This chat read untrusted content and holds private data, and this call would send a search query.",
  "private-group-reply": "This chat read untrusted content and holds private data, and this reply goes to a group.",
};

/** The reply a message-started turn sends, and every tool that sends into a chat: a call to one is the turn speaking. */
export const CHANNEL_REPLY_TOOL = "messaging.send";

const CHANNEL_SEND_TOOLS: ReadonlySet<string> = new Set([CHANNEL_REPLY_TOOL, "messaging.send_to"]);

/** The gate as a turn reads it: each call's verdict, its provenance and source checks, its approval, and a reply's channel and disarm. */
export function createGateScope(scope: OfferScope) {
  const {
    approvalFor,
    channelOf,
    checkedByHooks,
    executionPolicyOf,
    hiddenByRule,
    hookEnvelopeOf,
    labelOfMessage,
    needsApproval,
    now,
    options,
    originOf,
    rulesFor,
    turnLabel,
    turnTainted,
  } = scope;
  /**
   * The argument-provenance window: the newest 100 KB of the
   * checkpointed conversation — never the send-time request, whose folded
   * `context-` block is not the person's words — newest first. The
   * person's own messages are `person` (a worker's prompts are its spawning
   * model's, so none); a tool's result and quoted data carry where they came
   * from, by their label's newest ref; the model's own words and the
   * runtime's trusted blocks are not searched, so a string only they hold is
   * `unmatched`. Walked from the newest message, and stopped at the bound.
   */
  const provenanceWindowOf = (
    conversation: readonly WorkflowMessage[],
    origin: string | null | undefined,
  ): readonly ProvenanceWindowEntry[] => {
    const entries: ProvenanceWindowEntry[] = [];
    let held = 0;
    for (let index = conversation.length - 1; index >= 0 && held < ARG_PROVENANCE_LIMITS.windowChars; index -= 1) {
      const message = conversation[index];
      if (message === undefined || message.role === "assistant" || message.role === "system") continue;
      if (isPersonMessage(message)) {
        if (origin === "agent") continue;
        entries.push({ text: message.text, from: "person" });
        held += message.text.length;
        continue;
      }
      if (message.role === "user" && message.id.startsWith(CONTEXT_MESSAGE_PREFIX)) continue;
      const label = labelOfMessage(message);
      // A trusted block of the runtime's own (a notices block, a trusted summary) is no one's content.
      if (message.role !== "tool" && !isUntrusted(label)) continue;
      const parts = [message.text];
      if (message.role === "tool") stringLeaves(message.output, parts);
      const text = parts.filter((part) => part !== "").join("\n");
      const ref = isUntrusted(label) ? label.refs[0] : undefined;
      const source = ref?.source ?? (isUntrusted(label) ? label.sources[0] : undefined);
      // A built-in desktop tool's screen whose label named no app (a failed call's): the screen still, by the tool's
      // built-in origin, never by its id alone, which any plugin may choose (QA 1893).
      const host =
        ref?.host ??
        (source === "web" && message.toolName?.startsWith("desktop.") === true && options.tools.get(message.toolName)?.builtIn === true
          ? DESKTOP_HOST_PREFIX
          : undefined);
      entries.push({
        text,
        from: "content",
        ...definedOnly({ source, host, toolId: message.toolName, ref: ref?.ref }),
      });
      held += text.length;
    }
    return provenanceWindow(entries.reverse());
  };
  /** A request entry's `provenance` from its checkpointed verdict, when it has something to say. */
  const provenanceOfVerdict = (verdict: GateVerdict | undefined): { provenance?: ApprovalProvenance } => {
    const provenance = verdict === undefined ? undefined : approvalProvenanceOf(verdict);
    return provenance === undefined ? {} : { provenance };
  };
  /** A verdict with where its call's strings appear: display only, nothing else of it changes. */
  const withArgOrigins = (verdict: GateVerdict, input: unknown, window: readonly ProvenanceWindowEntry[]): GateVerdict => {
    try {
      const origins = argumentOrigins(input, window);
      return origins.length === 0 ? verdict : { ...verdict, argOrigins: [...origins] };
    } catch {
      // Display only: a call whose strings cannot be read is shown without them.
      return verdict;
    }
  };
  /**
   * `verdict` with its tool's `checkSources` applied: a refusal is a denial
   * with its reason; statuses go onto the verdict (`sourceChecks`) and its
   * form rows, an `unmatched` one raises the risk to high, and the hash
   * becomes the verdict's `contentHash`. A check that throws denies: a
   * source nobody could read verifies nothing.
   */
  const withSourceChecks = async (
    verdict: GateVerdict,
    definition: RegisteredTool,
    input: unknown,
    invocation: InvocationContext,
    window: () => readonly ProvenanceWindowEntry[],
    signal?: AbortSignal,
  ): Promise<GateVerdict> => {
    const check = definition.checkSources;
    if (check === undefined) return verdict;
    // The person's own words, without the lines that quote what a sender attached: those are the sender's.
    const entries = window();
    const personTexts = entries
      .filter((entry) => entry.from === "person")
      .map((entry) => entry.text.replace(/\[Attachment[^\]\n]*\]/g, ""));
    // What the conversation was sent: the artifacts its attachment lines name, from the blocks the host itself
    // labelled `attachment` only — a sender's message or a fetched page could hold a line of the same shape.
    const conversationArtifacts = [
      ...new Set(
        entries
          .filter((entry) => entry.from === "content" && entry.source === "attachment")
          .flatMap((entry) =>
            [...entry.text.matchAll(/\[Attachment[^\]\n]*\): artifact (art-[A-Za-z0-9_-]{1,128}), /g)].map((match) => match[1] as string),
          ),
      ),
    ];
    let result: SourceCheck;
    try {
      const normalized = z.safeParse(definition.inputSchema, input);
      if (!normalized.success) return verdict;
      result = await check(normalized.data, invocation, {
        personTexts,
        conversationArtifacts,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      options.onDiagnostic?.("a call's sources could not be checked", { toolId: definition.id, error: errorMessage(error) });
      return { ...verdict, decision: "deny", reason: "Its sources could not be checked, so it was not asked." };
    }
    if ("refused" in result) return { ...verdict, decision: "deny", reason: result.refused.slice(0, 500) };
    // The hash is checkpointed with the verdict: one of the wrong shape denies this call, not the run.
    if (!/^[a-f0-9]{64}$/.test(result.contentHash))
      return { ...verdict, decision: "deny", reason: "Its sources could not be checked, so it was not asked." };
    const form = verdict.display.form;
    // A row the check said nothing of is unmatched, never whatever the assessor guessed.
    const statuses =
      form === undefined ? result.statuses.slice(0, 512) : form.rows.map((_, index) => result.statuses[index] ?? "unmatched");
    // The note is the safety part (whose file it is): the source is shortened to keep it whole.
    const noted = (source: string, index: number): string => {
      const note = result.notes?.[index]?.slice(0, 120);
      if (note === undefined) return source;
      const room = 160 - note.length - 3;
      return `${clip(source, room)} (${note})`;
    };
    const display =
      form === undefined
        ? verdict.display
        : {
            ...verdict.display,
            form: {
              ...form,
              rows: form.rows.map((row, index) => ({ ...row, source: noted(row.source, index), status: statuses[index] ?? "unmatched" })),
            },
          };
    const unmatched = statuses.includes("unmatched");
    const risk = unmatched
      ? {
          ...verdict.risk,
          level: maxRisk(verdict.risk.level, "high"),
          reasons: [...verdict.risk.reasons, "a value's source is not where it says (unmatched)"].slice(0, 16),
        }
      : verdict.risk;
    return { ...verdict, display, sourceChecks: [...statuses], contentHash: result.contentHash, risk };
  };
  /** Decide one emitted call against the rules and grants in force now. */
  const gateVerdictFor = async (
    current: ReturnType<typeof parseAgentState>,
    call: { readonly id: string; readonly name: string; readonly input: unknown },
    label: ContentLabel,
    envelope?: ModEnvelope,
    signal?: AbortSignal,
    invocation: InvocationContext = current.invocation,
    known?: () => ReadonlySet<string>,
    window?: () => readonly ProvenanceWindowEntry[],
    typedInto?: Set<string>,
  ): Promise<GateVerdict | undefined> => {
    const tainted = isUntrusted(label);
    const definition = options.tools.get(call.name);
    if (definition === undefined) return undefined;
    let assessment: CallAssessment | undefined;
    if (definition.assess !== undefined) {
      try {
        // The definition's own schema, which is what dispatch validates with.
        // Input it refuses is never dispatched, so it needs no reading.
        const normalized = z.safeParse(definition.inputSchema, call.input);
        // The call's own context: the chat's folder is on it, resolved at this admission.
        if (normalized.success) assessment = definition.assess(normalized.data, invocation);
        // The pages it types into: what they show next may hold what was typed.
        const sessionId =
          normalized.success && typeof normalized.data === "object" && normalized.data !== null
            ? (normalized.data as { readonly sessionId?: unknown }).sessionId
            : undefined;
        for (const step of assessment?.browserSteps ?? []) {
          if (step.kind === "type" && typeof sessionId === "string")
            typedInto?.add(typedPageEntry(sessionId, step.url === undefined ? undefined : originKeyOf(step.url)));
        }
      } catch {
        // An assessor that cannot read a call makes it riskier, never safer.
        assessment = { display: { title: `Run ${call.name}` }, subjects: [], risk: "high", reasons: ["the call could not be assessed"] };
      }
    }
    if (definition.resolveBinding !== undefined) {
      try {
        const normalized = z.safeParse(definition.inputSchema, call.input);
        if (normalized.success) {
          const resolved = await definition.resolveBinding(normalized.data, invocation);
          assessment = {
            ...assessment,
            display: {
              ...(assessment?.display ?? { title: `Run ${call.name}` }),
              destination: `${resolved.binding.accountId} at ${resolved.binding.endpoint}`,
            },
            subjects: assessment?.subjects ?? [],
            risk: assessment?.risk ?? "medium",
            reasons: assessment?.reasons ?? [],
            bindingHash: resolved.bindingHash,
          };
        }
      } catch {
        assessment = {
          display: { title: `Run ${call.name}` },
          subjects: [],
          risk: "high",
          reasons: ["provider binding unavailable"],
          hardDeny: "Provider binding could not be resolved for this account",
        };
      }
    }
    // A masked secret cannot be written back: a model that read `[redacted:aws-key]`
    // and writes the file again would replace the person's key with the placeholder.
    // The call's own effect, raised by its assessment (a read tool sending a video to a remote analyser).
    if (effectiveEffect(definition.effect, assessment?.effect) !== "read-only" && containsRedactionPlaceholder(call.input)) {
      assessment = {
        ...assessment,
        display: assessment?.display ?? { title: `Run ${call.name}` },
        subjects: assessment?.subjects ?? [],
        risk: "high",
        reasons: [...(assessment?.reasons ?? []), "the input holds a masked secret"],
        hardDeny:
          "This call's input holds a masked secret ([redacted:…]): writing it would replace the real value with the placeholder. Ask the person to make this change themselves.",
      };
    }
    // A tool outside the task's allowlist (a heartbeat tick's) is core's to deny: never offered, and
    // never put to a plugin's tool.check, which can only tighten what core decides.
    const executionPolicy = await executionPolicyOf(current.runId);
    if (!policyAllowsTool(executionPolicy, definition.id)) {
      assessment = {
        ...assessment,
        display: assessment?.display ?? { title: `Run ${call.name}` },
        subjects: assessment?.subjects ?? [],
        risk: assessment?.risk ?? "high",
        reasons: assessment?.reasons ?? [],
        hardDeny: "This task cannot use this tool",
      };
    }
    // A reader session (a run an email started, and its workers) runs only what reads and reaches nothing outside,
    // whatever an allow rule, a grant or its schedule's tool list says: a send to its schedule's own delivery
    // destination is the one exception.
    if (
      !readerSessionAllows(
        executionPolicy,
        {
          id: definition.id,
          effect: effectiveEffect(definition.effect, assessment?.effect),
          sink: assessment?.sink ?? ("sink" in definition ? definition.sink : undefined),
        },
        { hasDelivery: invocation.scheduleDelivery !== undefined, assessedSink: assessment?.sink, atGate: true },
      )
    ) {
      assessment = {
        ...assessment,
        display: assessment?.display ?? { title: `Run ${call.name}` },
        subjects: assessment?.subjects ?? [],
        risk: "high",
        reasons: assessment?.reasons ?? [],
        hardDeny: "This run was started by an email and may only read: this tool changes, sends or fetches something, so it was not run.",
      };
    }
    const origin = await originOf(current.runId);
    const taintMode = (await options.taintMode?.(current.invocation.workspaceId)) ?? "enforce";
    let verdict = evaluateGate({
      toolId: definition.id,
      effect: definition.effect,
      ...(assessment === undefined ? {} : { assessment }),
      rules: await rulesFor(current.invocation.workspaceId, current.invocation),
      sessionGrants: (await options.toolPolicy?.sessionGrants(current.runId)) ?? [],
      gatedEffects: approvalFor as ReadonlySet<ToolEffect>,
      tainted,
      // The context label the call is emitted under: the verdict carries its summary.
      label,
      origin,
      channel: await channelOf(current.invocation),
      // The front end this turn was typed in: a canvas turn of a Home `tavi chat` began is held to `web` rules too.
      frontEnd: current.invocation.frontEnd,
      // The taint step: the tool's static sink, which its assessment may narrow per call.
      ...("sink" in definition && definition.sink !== undefined ? { sink: definition.sink } : {}),
      ...(definition.urlOnly === undefined ? {} : { urlOnly: definition.urlOnly }),
      taintMode,
      // Read only when the step can ask: a clean conversation's calls skip it.
      ...(tainted && taintMode !== "off" && known !== undefined ? { knownUrls: known() } : {}),
      // The person's own words: a page path they wrote is theirs to open, tainted or not.
      ...(tainted && taintMode !== "off" ? { personTexts: personTexts(current.conversation, origin) } : {}),
      // The `allowed-tools` of the skills loaded this turn: a call outside them asks, or is refused unattended.
      skillCeiling: turnSkillCeiling(current.conversation),
    });
    // A destructive tool's card says so, and is asked about each time: no grant for the session or for good.
    if (verdict.decision === "ask" && toolAnnotationsOf(definition).destructive)
      verdict = {
        ...verdict,
        display: { ...verdict.display, destructive: true },
        allowedScopes: verdict.allowedScopes.filter((scope) => scope === "once"),
      };
    // Nobody attends a routine's run or a heartbeat tick: the ask is a denial, with the same reason.
    if (verdict.decision === "ask" && verdict.gateReason !== undefined && (options.taintAsksDeny === true || isPlumbingOrigin(origin))) {
      verdict = {
        ...verdict,
        decision: "deny",
        reason:
          `${verdict.gateReason === "outside-skill-ceiling" ? skillCeilingRefusal(verdict.skillCeiling) : GATE_REASON_REFUSALS[verdict.gateReason]} Nobody can approve it in this run, so it was not made.`.slice(
            0,
            500,
          ),
      };
    }
    // A heartbeat tick denies what a schedule's fire denies: a tainted call
    // to an `askWhenTainted` tool, or a critical one, in every taint mode — not only the taint step's ask.
    // A routine's run is unattended too: a call only a person decides is denied there as well.
    const unattendedRun = isPlumbingOrigin(origin) || (options.taintAsksDeny === true && verdict.attendedOnly === true);
    const unattended = verdict.decision === "ask" && unattendedRun ? unattendedDenial(verdict) : undefined;
    if (unattended !== undefined) verdict = { ...verdict, decision: "deny", reason: unattended.slice(0, 500) };
    // A schedule's fire, and every worker it spawns, never creates or changes schedules or routines: an allow
    // rule or a grant that lets the call through elsewhere does not here. The fire's own ask is left to its
    // policy loop, which denies it too and tells the owner when the schedule's tool list names the tool.
    const schedulingWrite =
      origin === "schedule" || executionPolicy.schedulingWritesDenied === true ? scheduledWorkDenial(definition.id) : undefined;
    if (schedulingWrite !== undefined && !(verdict.decision === "ask" && (await options.tasks.get(current.runId))?.origin === "schedule"))
      verdict = { ...verdict, decision: "deny", reason: schedulingWrite.slice(0, 500) };
    // The injection detector: read after every decision is made — the hooks' included — so a hit
    // can only add its reason and raise the risk, never allow, deny or lower anything. Only for an ask, the
    // one decision whose card shows the warning.
    // A call its tool's own schema refuses is refused before any card: an approval could not make it run, and
    // the model reads what is wrong instead of a failure after someone said yes. Before the hooks and the
    // detector, which would only be paid for a call that cannot be asked; a hook's own ask is held to it below.
    const malformed = verdict.decision === "deny" ? undefined : malformedInput(definition, call.input);
    if (malformed !== undefined && verdict.decision === "ask") verdict = { ...verdict, decision: "deny", reason: malformed };
    const hookedAsIs = await checkedByHooks(verdict, call, definition, assessment, envelope, signal, invocation);
    // A hook may only make a call stricter: an ask it raises in a run nobody attends is a denial too.
    const hooked =
      hookedAsIs.decision === "ask" && isPlumbingOrigin(origin)
        ? {
            ...hookedAsIs,
            decision: "deny" as const,
            reason: (unattendedDenial(hookedAsIs) ?? "Nobody can approve it in this run, so it was not made.").slice(0, 500),
          }
        : hookedAsIs;
    const askable =
      malformed !== undefined && hooked.decision === "ask" ? { ...hooked, decision: "deny" as const, reason: malformed } : hooked;
    const checked = tainted && askable.decision === "ask" ? await withDetectorHits(askable, current, signal) : askable;
    // Where the call's strings appear: read after the decision, for the card only — it never changes one.
    const provenanceWindow = window ?? (() => provenanceWindowOf(current.conversation, origin));
    const withOrigins = checked.decision === "ask" ? withArgOrigins(checked, call.input, provenanceWindow()) : checked;
    // The call's sources, checked before the person is asked: a failed one denies
    // the call before any card; otherwise each row shows its checked status, and the hash binds what was checked.
    const decided =
      withOrigins.decision === "ask" && definition.checkSources !== undefined
        ? await withSourceChecks(withOrigins, definition, call.input, invocation, provenanceWindow, signal)
        : withOrigins;
    // What the taint step asked, or would have asked: the decision as it stands after the hooks.
    const observation =
      options.recordGateObservation === undefined
        ? undefined
        : gateObservationOf(decided, {
            taskId: current.runId,
            callId: call.id,
            effect: decided.effect ?? definition.effect,
            sink: assessment?.sink ?? ("sink" in definition ? definition.sink : undefined),
            at: now(),
          });
    if (observation !== undefined) {
      try {
        await options.recordGateObservation?.(observation);
      } catch (error) {
        options.onDiagnostic?.("a gate observation could not be recorded", {
          taskId: current.runId,
          toolId: observation.toolId,
          error: errorMessage(error),
        });
      }
    }
    return decided;
  };
  /**
   * `verdict` with the injection detector's hits on the conversation's
   * untrusted content: the newest `MAX_DETECTOR_ITEMS` untrusted
   * messages, a tool result by its string leaves. Raise-only
   * (`withInjectionWarning`); a detector that is absent, off or failing
   * leaves the verdict as it is.
   */
  /** The flagged messages already logged (`task\u0000message`), so a cached hit is logged once, not on every later call. */
  const detectorLogged = new Set<string>();
  const withDetectorHits = async (
    verdict: GateVerdict,
    current: ReturnType<typeof parseAgentState>,
    signal: AbortSignal | undefined,
  ): Promise<GateVerdict> => {
    if (options.injectionScan === undefined) return verdict;
    try {
      const items: { ref: string; source: SourceKind; text: string }[] = [];
      for (let index = current.conversation.length - 1; index >= 0 && items.length < MAX_DETECTOR_ITEMS; index -= 1) {
        const message = current.conversation[index];
        if (message === undefined || (message.role === "user" && message.id.startsWith(CONTEXT_MESSAGE_PREFIX))) continue;
        if (message.role !== "tool" && !isQuotedDataMessage(message)) continue;
        const label = labelOfMessage(message);
        if (!isUntrusted(label)) continue;
        // The host's own fence around an inbound block is Tavi's, never a forged marker.
        const parts = [inboundBody(message.text)];
        if (message.role === "tool") stringLeaves(message.output, parts);
        const text = parts.filter((part) => part !== "").join("\n");
        if (text === "") continue;
        items.push({ ref: message.id, source: label.sources[0] ?? "unknown-source", text });
      }
      if (items.length === 0) return verdict;
      const hits = await options.injectionScan({
        workspaceId: current.invocation.workspaceId,
        taskId: current.runId,
        invocation: current.invocation,
        items,
        signal,
      });
      if (hits.length === 0) return verdict;
      const reasons = [...new Set(hits.map((hit) => injectionWarningReason(hit.source, hit.signals)))];
      const fresh = hits.filter((hit) => !detectorLogged.has(`${current.runId}\u0000${hit.ref}`));
      if (fresh.length > 0) {
        for (const hit of fresh) {
          detectorLogged.add(`${current.runId}\u0000${hit.ref}`);
          const oldest = detectorLogged.values().next();
          if (detectorLogged.size > 4_096 && oldest.done !== true) detectorLogged.delete(oldest.value);
        }
        options.onDiagnostic?.("the injection detector flagged untrusted content in this chat", {
          taskId: current.runId,
          toolId: verdict.toolId,
          hits: fresh.map((hit) => `${hit.source}:${hit.signals.join("+")}`).slice(0, 8),
        });
      }
      return withInjectionWarning(verdict, reasons);
    } catch {
      return verdict;
    }
  };
  /** The checkpointed verdict for a pending call, if it was decided for this tool. */
  const verdictOf = (
    current: ReturnType<typeof parseAgentState>,
    call: { readonly id: string; readonly name: string },
  ): GateVerdict | undefined => {
    const verdict = current.gateVerdicts[call.id];
    return verdict !== undefined && verdict.toolId === call.name ? verdict : undefined;
  };
  /**
   * Whether a person authorized this call: they approved it in a round, or its
   * verdict was an allow by a grant they gave for this task or a rule they saved.
   * A shipped rule, a `serve --allow` flag or an ungated effect asked no one.
   */
  const operatorApproved = async (
    current: ReturnType<typeof parseAgentState>,
    call: { readonly id: string; readonly name: string },
  ): Promise<boolean> => {
    if (callNeedsApproval(current, call)) return (await roundApprover(current, call)) !== undefined;
    const verdict = verdictOf(current, call);
    if (verdict?.decision !== "allow" || verdict.ruleId === undefined) return false;
    const ruleId = verdict.ruleId;
    if (
      ((await options.toolPolicy?.sessionGrants(current.runId)) ?? []).some(
        (grant) => grant.grantId === ruleId && !isAutomaticDecider(grant.createdBy),
      )
    )
      return true;
    return (await rulesFor(current.invocation.workspaceId, current.invocation)).some(
      (rule) => rule.ruleId === ruleId && rule.source === "operator",
    );
  };
  /**
   * The person who approved this very call in its round — this round's own
   * row, decided by a person, not a schedule's policy or a blanket `--approval
   * approve`, which saw no call — or `undefined` (see `ToolHandler`'s
   * `approvedBy`). A rule or a grant names no one: they saw another call.
   */
  const roundApprover = async (
    current: ReturnType<typeof parseAgentState>,
    call: { readonly id: string; readonly name: string },
  ): Promise<string | undefined> => {
    if (!callNeedsApproval(current, call)) return undefined;
    const approvalId = approvalRowId(current.runId, call.id, current.steps);
    const row = await options.approvals.getForCall(current.runId, call.id, current.steps);
    return current.approvals[call.id] === approvalId &&
      row?.approvalId === approvalId &&
      row.state === "granted" &&
      row.decidedBy !== null &&
      !isAutomaticDecider(row.decidedBy)
      ? row.decidedBy
      : undefined;
  };
  /** Whether a pending call waits for a round: its verdict says so, or — for a checkpoint from before verdicts — its effect does. */
  const callNeedsApproval = (
    current: ReturnType<typeof parseAgentState>,
    call: { readonly id: string; readonly name: string },
  ): boolean => {
    const verdict = verdictOf(current, call);
    return verdict === undefined ? needsApproval(options.tools.get(call.name)) : verdict.decision === "ask";
  };
  /**
   * A model step's updates to the known-URL channels: the URLs of the
   * person's messages since the model last answered (their turn's prompt, a
   * steer), which are known; and the URLs the generation wrote — its answer
   * and its calls' inputs — that nothing made known before, which no later
   * tool result may make known by echoing them.
   */
  const urlChannelUpdates = async (
    current: ReturnType<typeof parseAgentState>,
    answer: string,
    calls: readonly { readonly input: unknown }[],
    systemText: string,
    /** The task's origin as the step already read it (`StepFacts`). */
    originRead: () => Promise<string | null | undefined> = () => originOf(current.runId),
  ): Promise<{ knownUrls?: readonly string[]; modelUrls?: readonly string[] }> => {
    const origin = await originRead();
    const lastAnswer = current.conversation.findLastIndex((message) => message.role === "assistant");
    const have = new Set(current.knownUrls);
    const people = urlKeysOf(personTexts(current.conversation.slice(lastAnswer + 1), origin)).filter((key) => !have.has(key));
    const written: string[] = [answer];
    for (const call of calls) stringLeaves(call.input, written);
    const writtenKeys = urlKeysOf(written);
    const known = writtenKeys.length === 0 ? undefined : knownUrlSetOf(current.knownUrls, current.conversation, systemText, origin);
    const novel = known === undefined ? [] : writtenKeys.filter((key) => !known.has(key));
    return { ...(people.length === 0 ? {} : { knownUrls: people }), ...(novel.length === 0 ? {} : { modelUrls: novel }) };
  };
  /**
   * The outbound disarm of a tainted turn:
   * defangs every address in a text but a URL the conversation knows — the
   * `knownUrls` channel and the person's messages, as the gate's known-URL
   * rule reads them (never `modelUrls`). The system text is not read here, so
   * a URL only the prompt or a skill names is defanged too: stricter, never looser.
   */
  const replyDisarm = async (current: ReturnType<typeof parseAgentState>): Promise<(text: string) => string> => {
    const known = knownUrlSetOf(current.knownUrls, current.conversation, "", await originOf(current.runId));
    return (text) => disarmUrls(text, known);
  };
  /**
   * What a one-to-one chat's completed turn leaves to be sent for it when it
   * tried no send of its own (`AdmissionOutcome.channelReply`): its answer,
   * under the controls a `messaging.send` of it meets — offered to the turn,
   * let through by the gate without a round, and disarmed in a tainted turn.
   * A send the turn tried, whether it went, was
   * denied or was refused, leaves nothing: the turn already spoke, or was
   * told not to.
   */
  const channelReplyOf = async (current: ReturnType<typeof parseAgentState>): Promise<AdmissionOutcome["channelReply"]> => {
    const replyTo = current.invocation.messagingReplyTo;
    const text = current.finalText.trim();
    if (replyTo === undefined || replyTo.audience !== "one-to-one" || text === "") return undefined;
    const turnStart = current.conversation.findLastIndex((message) => isPersonMessage(message));
    const triedSend = current.conversation
      .slice(turnStart + 1)
      .some((message) => message.role === "assistant" && (message.toolCalls ?? []).some((call) => CHANNEL_SEND_TOOLS.has(call.name)));
    const definition = options.tools.get(CHANNEL_REPLY_TOOL);
    if (triedSend || definition === undefined || (await hiddenByRule(current.invocation, current.runId))(CHANNEL_REPLY_TOOL))
      return undefined;
    const content = turnTainted(current) ? (await replyDisarm(current))(text) : text;
    const callId = "channel-reply";
    const verdict = (await gateVerdictsOf(current, [{ id: callId, name: CHANNEL_REPLY_TOOL, input: { content } }]))[callId];
    const allowed = verdict === undefined ? !needsApproval(definition) : verdict.decision === "allow";
    return allowed ? { content, replyTo } : undefined;
  };
  /** Verdicts for one generation's calls, keyed by call id. */
  const gateVerdictsOf = async (
    current: ReturnType<typeof parseAgentState>,
    calls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[],
    signal?: AbortSignal,
    invocation: InvocationContext = current.invocation,
    systemText = "",
    typedInto?: Set<string>,
    /** The task's origin as the step already read it (`StepFacts`). */
    originRead: () => Promise<string | null | undefined> = () => originOf(current.runId),
  ): Promise<Record<string, GateVerdict>> => {
    const label = turnLabel(current);
    const origin = await originRead();
    // The known-URL set, built once for the generation's calls and only if one needs it.
    let knownSet: ReadonlySet<string> | undefined;
    const known = (): ReadonlySet<string> => (knownSet ??= knownUrlSetOf(current.knownUrls, current.conversation, systemText, origin));
    // The argument-provenance window, built once for the generation's asks and only if one is asked.
    let windowEntries: readonly ProvenanceWindowEntry[] | undefined;
    const window = (): readonly ProvenanceWindowEntry[] => (windowEntries ??= provenanceWindowOf(current.conversation, origin));
    // No `tool.check` hook at all: no envelope to build (the zero-hook fast path). Asked at each
    // call, so a hook registered while the round's earlier calls were judged is asked about the later ones.
    let built: Promise<ModEnvelope> | undefined;
    const envelopeNow = async (): Promise<ModEnvelope | undefined> => {
      if (options.turnHooks === undefined || options.turnHooks.hasEvent?.("tool.check") === false) return undefined;
      built ??= hookEnvelopeOf(current.runId, invocation).then((envelope) => Object.freeze(envelope));
      return built;
    };
    const verdicts: Record<string, GateVerdict> = {};
    for (const call of calls) {
      const verdict = await gateVerdictFor(current, call, label, await envelopeNow(), signal, invocation, known, window, typedInto);
      if (verdict !== undefined) verdicts[call.id] = verdict;
    }
    return verdicts;
  };
  return {
    ...scope,
    provenanceOfVerdict,
    verdictOf,
    operatorApproved,
    roundApprover,
    callNeedsApproval,
    urlChannelUpdates,
    replyDisarm,
    channelReplyOf,
    gateVerdictsOf,
  };
}

/** Why `input` does not fit `definition`'s schema, in words the model reads; `undefined` when it fits. */
function malformedInput(definition: Pick<RegisteredTool, "id" | "inputSchema">, input: unknown): string | undefined {
  const parsed = z.safeParse(definition.inputSchema, input);
  if (parsed.success) return undefined;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return clip(`${definition.id} was not asked: its input does not fit the tool (${issues}). Fix it and call again.`, 500);
}
