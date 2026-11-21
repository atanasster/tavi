import {
  type ToolDefinition,
  isAttendedOrigin,
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  isPersonMessage,
  MAX_MODEL_TOOLS,
  TaviError,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { prepareContextAdvice, type PreparedContextAdvice } from "../../../context/context.js";
import {
  TOOL_SEARCH_ID,
  appendDiscovered,
  documentTools,
  fitToolList,
  namedTools,
  LINK_OPENING_TOOLS,
  mentionsPdf,
  mentionsReminder,
  mentionsAudio,
  mentionsVideo,
  selectToolAdvice,
  toolAdviceCandidates,
  shortlistTools,
  routedToolList,
  routedToolIdsOf,
  toolRevision,
  toolSearchDefinition,
} from "../../../tools/tool-routing.js";
import { turnOpeningPerson } from "../../context-block.js";
import { contextActor } from "../../prompt.js";
import { contextQueryFrom, turnRetrievalQueryFrom } from "../../retrieval.js";
import { executionLeaseOf, assertLeaseCurrent } from "../../run-config.js";
import { MEMORY_PROPOSE_TOOL_ID } from "../../scope/core.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, handoffAllowed } from "../../waits.js";
import { type ModelStep, turnQueryOptions } from "./context.js";
import type { Instructions } from "./instructions.js";

/** The tools this step is offered: the turn's catalog, a routed shortlist, and the final step's list. */
export async function offerTools(step: ModelStep, instructions: Instructions) {
  const { executionPolicy } = instructions;
  const { config, admission, current, facts, latestUser, newTurn, layout, turnStepsSoFar, taskMaxSteps } = step;
  const {
    authorizedTools,
    hiddenByRule,
    maxToolCalls,
    options,
    toolSearchFor,
    defersBuiltins: defersBuiltinsFor,
    deferredFor,
  } = step.scope;
  // Generated facts join the *mandatory* prefix, outside the optional retrieval
  // path below: a retrieval failure must not silently drop them, and a
  // no-memory adapter must still receive them.
  // The offered set is computed once, before the facts, so the block and the
  // model's tool list cannot disagree: a tool the policy removes is neither
  // offered nor named. The facts follow the turn's set, before
  // a step's routing shortlist or the final step's empty list.
  const hiddenTool = await hiddenByRule(current.invocation, current.runId, facts);
  // `v1`: a turn's own discoveries; `v2`: the epoch's, kept in the order found and appended after the rest.
  const discovered = layout === "v2" ? (step.epochBegins ? [] : current.discoveredToolIds) : newTurn ? [] : current.discoveredToolIds;
  const routedEarlier = layout === "v2" && !step.epochBegins ? current.routedToolIds : [];
  /** The tools a routed shortlist offered, kept for the epoch's next turn (`routedToolIds`) under `v2`. */
  let routedNow: readonly string[] | undefined;
  // The turn's last step, or no tool calls left: the model answers from what it gathered (`v1` offers it
  // no tools; `v2` keeps them listed, and a call it makes is not run) rather than the guard failing the
  // turn and discarding it.
  const finalStep =
    taskMaxSteps > 1 && turnStepsSoFar > 0 && (turnStepsSoFar + 1 >= taskMaxSteps || (newTurn ? 0 : current.turnToolCalls) >= maxToolCalls);
  // Every tool the task may be offered, deferred ones included: what `v2` states its runtime facts from, so a
  // discovery changes no system text.
  // An attended chat's rarely used built-in families wait behind `tools.search` under `v2` (`deferredFor`).
  const defersBuiltins = await defersBuiltinsFor(current.invocation, current.runId, facts);
  const catalog = (await deferredFor(current.invocation, current.runId, await facts.offered(), facts))
    .filter((definition) => definition.id !== ASK_USER_TOOL_ID || executionPolicy.humanQuestionsAllowed)
    .filter(
      (definition) =>
        definition.id !== BROWSER_REQUEST_HANDOFF_TOOL_ID || (handoffAllowed(executionPolicy) && options.browserHandoff?.() !== undefined),
    )
    .filter((definition) => definition.id !== AGENTS_WAIT_TOOL_ID || executionPolicy.workerWaitsAllowed)
    .filter((definition) => !hiddenTool(definition.id));
  // A PDF or video the person's words hold brings its deferred tools in as found, never by rank: appended
  // where `v2` appends a discovery, so the tool array only grows.
  const personTexts = step.conversationForThisCall.filter(isPersonMessage).map((message) => message.text);
  // A reminder turn's words bring in the reminder tools that wait behind the search, as a PDF's do the PDF tools.
  const documentFound = defersBuiltins
    ? documentTools(mentionsPdf(personTexts), mentionsVideo(personTexts), mentionsReminder(personTexts), mentionsAudio(personTexts))
    : [];
  const discoveredNow = documentFound.length === 0 ? discovered : appendDiscovered(discovered, documentFound);
  let offeredTools: readonly ToolDefinition[] = fitToolList(
    catalog,
    discoveredNow,
    options.access.missingPermissions(current.invocation, toolSearchDefinition.requiredPermissions).length === 0 &&
      !hiddenTool(TOOL_SEARCH_ID),
    // A deferred tool a task's allowlist names, by id or pattern (a heartbeat's choice), is offered directly:
    // the task has no `tools.search` to find it.
    {
      // Its lines name only families this person may use, as the search that finds them (`authorizedTools`).
      search: await toolSearchFor(
        current.invocation,
        catalog.filter((definition) => options.access.missingPermissions(current.invocation, definition.requiredPermissions).length === 0),
      ),
      named: namedTools(catalog, executionPolicy.toolAllowlist),
      appendDiscovered: layout === "v2",
    },
  );
  // Whether the chat's tool set holds `memory.propose`, before any shortlist: the propose guidance
  // follows what is fixed for the chat between turns, never one call's routing.
  const factsTools = layout === "v2" ? catalog : offeredTools;
  const proposeAuthorized = factsTools.some((definition) => definition.id === MEMORY_PROPOSE_TOOL_ID);
  // The turn's tool set, before one step's shortlist or the final step's empty list: the runtime facts
  // are stated from it, so the system string is byte-identical across every call of the turn.
  // What this one call is offered — none on the final step — is the step facts' to say.
  // `v2`: the catalog, deferred tools included, so a `tools.search` discovery changes no system text either.
  const turnToolIds = new Set(factsTools.map((definition) => definition.id));
  // Every tool the chat may reach, deferred ones and `v1`'s final step included: whether a link can be opened at all.
  const linksUncheckable = !catalog.some((definition) => LINK_OPENING_TOOLS.includes(definition.id));
  let preparedContextAdvice: PreparedContextAdvice | undefined;
  let toolDisclosureRequired = false;
  let toolCatalogFingerprint: string | undefined;
  let toolConfigRevision: number | undefined;
  const taskForTools = await facts.task();
  const toolScope = { workspaceId: current.invocation.workspaceId, principalId: current.invocation.principalId };
  const timezone = options.workspaceTimezone === undefined ? undefined : await options.workspaceTimezone(current.invocation.workspaceId);
  if (options.routing !== undefined && isAttendedOrigin(taskForTools?.origin) && executionPolicy.mode === "attended") {
    const configuration = await options.routing.service.configuration(toolScope);
    if (
      configuration.settings.enabled &&
      (configuration.settings.modes.tools !== "off" ||
        (options.routing.service.decideBatch !== undefined &&
          (configuration.settings.modes.memory !== "off" || configuration.settings.modes.skills !== "off")))
    ) {
      const lease = executionLeaseOf(config);
      if (lease === undefined) throw new TaviError("UNAVAILABLE", "Tool routing requires a lease");
      const available = await authorizedTools(current, facts);
      const fingerprintOf = (tools: readonly ToolDefinition[]): string =>
        JSON.stringify(tools.map((tool) => [tool.id, toolRevision(options.tools, tool)]));
      // A re-check reads afresh: it guards against a permission, rule or tool changed meanwhile.
      const fingerprint = async () => fingerprintOf(await authorizedTools(current));
      const before = fingerprintOf(available);
      const decisionInput = {
        scope: toolScope,
        fence: { taskId: current.runId, generation: lease.generation, ownerSession: options.ownerSession },
        turnId: lease.admissionId,
        // `v2` asks once a turn: every step of it gets the same advice, so the tool set does not move.
        operationId: sha256Hex(
          JSON.stringify(layout === "v2" ? [lease.admissionId, "tools"] : [lease.admissionId, current.steps, "tools"]),
        ),
        permissionRevision: sha256Hex(before),
        prompt: contextQueryFrom(step.conversationForThisCall) ?? "",
        signal: admission?.signal ?? config?.signal ?? new AbortController().signal,
        isCurrent: async () => {
          await assertLeaseCurrent(options, config);
          return (
            (await options.cancellations.get(current.runId)) === undefined &&
            options.access.missingPermissions(current.invocation, ["models.invoke"]).length === 0 &&
            (await fingerprint()) === before
          );
        },
      };
      let advice: readonly string[] = [];
      if (options.routing.service.decideBatch !== undefined) {
        const contextQuery = turnRetrievalQueryFrom(step.conversationForThisCall, turnQueryOptions(step, timezone));
        // Under `v2` a later call of the turn reuses the context block its first call wrote: asking the router
        // about memory and skills again would only be thrown away (`contextKept` below).
        const blockKept = layout === "v2" && turnOpeningPerson(step.conversationForThisCall, latestUser)?.contextText !== undefined;
        const contextPlan =
          blockKept ||
          options.memory === undefined ||
          (configuration.settings.modes.memory === "off" && configuration.settings.modes.skills === "off")
            ? undefined
            : await prepareContextAdvice(
                {
                  memory: options.memory,
                  ...definedOnly({
                    skills: options.skills,
                    mailbox: options.mailbox,
                    skillRollout: options.skillRollout,
                    skillUsage: options.skillUsage,
                  }),
                },
                {
                  actor: contextActor(current.invocation),
                  instructions: "",
                  ...(options.memoryRecall?.profile === false ? { includeProfile: false } : {}),
                  ...(contextQuery === undefined
                    ? {}
                    : {
                        query: contextQuery.keywords,
                        queryMatch: "any" as const,
                        applyFloor: options.memoryRecall?.relevanceFloor !== false,
                        ...(options.memoryRecall?.rankingPriors === false ? { rankingPriors: false } : {}),
                        ...(contextQuery.semantic === undefined ? {} : { semantic: contextQuery.semantic }),
                        ...(contextQuery.alreadyShownIds === undefined ? {} : { alreadyShownIds: contextQuery.alreadyShownIds }),
                        ...(contextQuery.range === undefined || options.memoryRecall?.temporalRanking === false
                          ? {}
                          : {
                              range: { from: contextQuery.range.from, to: contextQuery.range.to },
                              ...(contextQuery.range.pastOnly ? { includePast: true } : {}),
                            }),
                      }),
                },
                {
                  service: options.routing.service,
                  fence: decisionInput.fence,
                  turnId: lease.admissionId,
                  step: current.steps,
                  signal: decisionInput.signal,
                  prompt: [...current.conversation].reverse().find(isPersonMessage)?.text ?? "",
                  isCurrent: decisionInput.isCurrent,
                },
              );
        // A final step offers no tools, so it asks the router nothing about them.
        const questions = [
          ...(configuration.settings.modes.tools === "off" || finalStep
            ? []
            : [{ ...decisionInput, feature: "tools" as const, candidates: toolAdviceCandidates(options.tools, available) }]),
          ...(contextPlan?.inputs ?? []),
        ];
        const receipts = await options.routing.service.decideBatch(questions);
        const toolsReceipt = await receipts.find((receipt) => receipt.feature === "tools");
        advice = toolsReceipt?.mode === "active" && (await decisionInput.isCurrent()) ? toolsReceipt.selectedIds : [];
        if (contextPlan !== undefined)
          preparedContextAdvice = contextPlan.accept(await receipts.filter((receipt) => receipt.feature !== "tools"));
      } else if (!finalStep) advice = await selectToolAdvice(options.routing.service, options.tools, decisionInput, available);
      await assertLeaseCurrent(options, config);
      const latest = await options.routing.service.configuration(toolScope);
      if (latest.settings.enabled && latest.settings.modes.tools === "active") {
        toolDisclosureRequired = true;
        const authorized = await authorizedTools(current);
        toolCatalogFingerprint = fingerprintOf(authorized);
        toolConfigRevision = latest.revision;
        // `v2` ranks by the person's words alone, so a tool result that names a PDF does not move the set mid-turn.
        const ranked = layout === "v2" ? step.conversationForThisCall.filter(isPersonMessage) : step.conversationForThisCall;
        const shortlist = shortlistTools(
          authorized,
          contextQueryFrom(ranked) ?? "",
          before === toolCatalogFingerprint && latest.revision === configuration.revision ? advice : [],
          discoveredNow,
          undefined,
          {
            pdfInConversation: mentionsPdf(ranked.map((message) => message.text)),
            videoInConversation: mentionsVideo(ranked.map((message) => message.text)),
            audioInConversation: mentionsAudio(ranked.map((message) => message.text)),
          },
        );
        if (layout === "v2") {
          // The final step asks the router nothing about tools: it offers the turn's routed tools as the step
          // before did, rather than a word-ranked shortlist that would change the array.
          offeredTools = routedToolList(authorized, routedEarlier, finalStep && routedEarlier.length > 0 ? [] : shortlist);
          routedNow = routedToolIdsOf(offeredTools);
        } else offeredTools = shortlist;
      }
    }
  }
  // `v1` sends a final step no tools; `v2` keeps them listed (a call is not run), so the cached prefix holds.
  if (finalStep && layout !== "v2") offeredTools = [];
  if (offeredTools.length > MAX_MODEL_TOOLS)
    throw new TaviError("INVALID_INPUT", `Offered tools exceed the ${MAX_MODEL_TOOLS}-descriptor model contract`);
  return {
    finalStep,
    documentFound,
    discoveredNow,
    factsTools,
    proposeAuthorized,
    turnToolIds,
    linksUncheckable,
    toolScope,
    timezone,
    offeredTools,
    routedNow,
    preparedContextAdvice,
    toolDisclosureRequired,
    toolCatalogFingerprint,
    toolConfigRevision,
  };
}

/** What `offerTools` decided. */
export type ToolOffer = Awaited<ReturnType<typeof offerTools>>;
