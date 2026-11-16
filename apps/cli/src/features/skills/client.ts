import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  SkillsBodyAnswerSchema,
  SkillsEditAnswerSchema,
  SkillsListAnswerSchema,
  SkillsShowAnswerSchema,
  SkillsTraceAnswerSchema,
  skillProposalChatOf,
  skillProposalUntrustedLine,
  skillRegenerateMessage,
  skillTraceLine,
  type SkillsTraceAnswer,
  skillBundleFileBytes,
  skillBundleFilesForReview,
  SKILL_UNUSED_DAYS,
  skillPackageFiles,
  skillProposalExpired,
  skillToolsEscalationText,
  skillActivationHistoryText,
  skillUsageOf,
  taviToolForSkillName,
  skillUsageText,
  type SkillUseSummary,
  TaviError,
  type SkillActor,
  type SkillsBodyAnswer,
  type SkillsListAnswer,
  type SkillsShowAnswer,
  SkillActivationSchema,
  SkillVersionSchema,
  type SkillVersion,
  type SkillsPayload,
  hostTimeZone,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { SkillRolloutService, SkillService } from "@tavi/runtime";

import { EXIT, refusalExit, reportRefusal } from "../../cli/exit.js";
import { requireFlag } from "../../cli/flags.js";
import type { CliIo } from "../../cli/io.js";
import { emit, emitError } from "../../cli/output.js";
import { CONFIG_TIMEOUT_MS, refuseOfflineOnly } from "../../cli/owner.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";
import { terminalText } from "../../shared/terminal-text.js";
import { fireTimeText } from "../schedules/actions.js";
import { readAgentSkillPackage } from "./bundle.js";
import { skillsOwnerCommand, storeTaskTools } from "./owner.js";
import type { SkillsCommandOptions } from "./parse.js";
import { operatorTrustedProvenance } from "./tools.js";

/** What the owner, or the store with none running, answered: its result, or the exit already reported. */
type SkillsReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly exit: number };

const SKILLS_REFUSAL_CODES = { usage: ["INVALID_INPUT", "REVISION_CONFLICT"], unavailable: ["NOT_FOUND"] } as const;

/**
 * One `skills` request: through a live owner, else on the directory itself,
 * through the same handler the owner runs (`skillsOwnerCommand`), so both
 * answer alike.
 */
async function skillsRequest(
  options: ResolvedDataDirectory<SkillsCommandOptions>,
  payload: SkillsPayload,
  io: CliIo,
): Promise<SkillsReply> {
  const client = await connectOwnerOrReport(options.dataDirectory, ["skills"], io, EXIT);
  if (typeof client === "number") return { ok: false, exit: client };
  if (client !== undefined) {
    try {
      const response = await client.request("skills", payload, prefixedId("skills"), { timeoutMs: CONFIG_TIMEOUT_MS });
      if (response.ok) return { ok: true, result: response.result };
      return { ok: false, exit: refusalExit(io, response.error, `tavi skills ${options.action} failed`) };
    } finally {
      client.close();
    }
  }
  try {
    return await withStore(options.dataDirectory, async (store) => {
      const answer = await skillsOwnerCommand(
        {
          service: new SkillService(store.asPort()),
          skills: store.asPort().repositories.skills,
          readArtifactBody: async (artifactId) => await store.readArtifactBody(artifactId),
          principalOf: () => options.principalId,
          readTaskTools: storeTaskTools(store),
          now: nowTimestamp,
        },
        payload,
      );
      if (answer.ok) return { ok: true as const, result: answer.result };
      // Refused as the owner's refusal is, so a refusal exits alike with an owner and without one.
      return { ok: false as const, exit: refusalExit(io, answer.error, `tavi skills ${options.action} failed`) };
    });
  } catch (error) {
    return { ok: false, exit: reportRefusal(error, io, "skills command failed", SKILLS_REFUSAL_CODES) };
  }
}

export async function skillsCommand(options: ResolvedDataDirectory<SkillsCommandOptions>, io: CliIo): Promise<number> {
  if (options.action === "pin-rollout" || options.action === "clear-rollout" || options.action === "rollout-status") {
    const refused = await refuseOfflineOnly(
      options.dataDirectory,
      `tavi skills ${options.action}`,
      "a task's rollout is set on the directory itself",
      io,
    );
    if (refused !== undefined) return refused;
    return await skillsRolloutCommand(options, io);
  }
  try {
    const workspaceId = options.workspaceId;
    switch (options.action) {
      case "list": {
        const reply = await skillsRequest(options, { action: "list", workspaceId }, io);
        if (!reply.ok) return reply.exit;
        const answer = SkillsListAnswerSchema.parse(reply.result);
        const rows = listedWithUsage(answer);
        emit(io, options.format, rows, (listed) =>
          listed.length === 0
            ? "(no skills)"
            : listed
                .map(
                  (v) =>
                    `${v.skillId}\t${v.version}\t${v.reviewState}${v.expired === true ? " (expired)" : ""}\t${v.manifest.name}\t${usageText(v.usage)}`,
                )
                .join("\n"),
        );
        return EXIT.ok;
      }
      case "show": {
        const skillId = requireSkillId(options);
        if (options.body === true) {
          const version = options.version ?? (await activeVersionOf(options, skillId, io));
          if (typeof version === "number") return version;
          const reply = await skillsRequest(options, { action: "body", workspaceId, skillId, version }, io);
          if (!reply.ok) return reply.exit;
          const answer = SkillsBodyAnswerSchema.parse(reply.result);
          const escalation = await escalationOf(options, answer, io);
          // An agent's proposal shows what its task did: the calls its stored history holds.
          const trace = answer.version.manifest.proposal === undefined ? undefined : await traceOf(options, skillId, version, io);
          emit(io, options.format, trace === undefined ? answer : { ...answer, trace }, (shown) =>
            [bodyText(shown.version, shown.text, escalation), ...(trace === undefined ? [] : [traceText(trace)])].join("\n\n"),
          );
          return EXIT.ok;
        }
        const reply = await skillsRequest(options, { action: "show", workspaceId, skillId }, io);
        if (!reply.ok) return reply.exit;
        emit(io, options.format, SkillsShowAnswerSchema.parse(reply.result), (shown) => showText(skillId, shown));
        return EXIT.ok;
      }
      case "import": {
        if (options.agentSkillPath !== undefined) {
          // An Agent Skills package: its frontmatter names it; its files are stored as one bundle.
          const read = readAgentSkillPackage(options.agentSkillPath);
          const version = options.version ?? read.version;
          if (version === undefined) {
            emitError(io, `${read.skillId} declares no metadata.version: give one with --version`);
            return EXIT.usage;
          }
          const reply = await skillsRequest(
            options,
            {
              action: "import",
              workspaceId,
              skillId: read.skillId,
              version,
              name: options.name ?? read.name,
              ...((options.description ?? read.description) === undefined ? {} : { description: options.description ?? read.description }),
              // Someone else's package unless the operator names its source: approved only with --yes, read as untrusted.
              provenance: options.provenance ?? `archive:${basename(options.agentSkillPath)}`.slice(0, 200),
              packageBase64: Buffer.from(read.text).toString("base64"),
              ...(read.allowedTools === undefined ? {} : { allowedTools: [...read.allowedTools] }),
              ...(read.compatibility === undefined ? {} : { compatibility: read.compatibility }),
              files: [...read.files],
            },
            io,
          );
          if (!reply.ok) return reply.exit;
          emit(io, options.format, reply.result, (imported) => importedText(SkillVersionSchema.parse(imported)));
          return EXIT.ok;
        }
        const packageBody = readPackageFile(requireFlag(options.packagePath, "--package"));
        const reply = await skillsRequest(
          options,
          {
            action: "import",
            workspaceId,
            skillId: requireSkillId(options),
            version: requireFlag(options.version, "--version"),
            name: requireFlag(options.name, "--name"),
            ...(options.description === undefined ? {} : { description: options.description }),
            provenance: requireFlag(options.provenance, "--provenance"),
            packageBase64: packageBody.toString("base64"),
          },
          io,
        );
        if (!reply.ok) return reply.exit;
        emit(io, options.format, reply.result, (imported) => importedText(SkillVersionSchema.parse(imported)));
        return EXIT.ok;
      }
      case "edit": {
        const body = readPackageFile(requireFlag(options.packagePath, "--package")).toString("utf8");
        const reply = await skillsRequest(
          options,
          { action: "edit", workspaceId, skillId: requireSkillId(options), version: requireFlag(options.version, "--version"), body },
          io,
        );
        if (!reply.ok) return reply.exit;
        const edited = SkillsEditAnswerSchema.parse(reply.result);
        emit(
          io,
          options.format,
          edited,
          (answer) =>
            `${answer.version.skillId}@${answer.version.version} proposed, following ${answer.replaced} (set aside): review it with tavi skills show ${answer.version.skillId} --body --version ${answer.version.version}`,
        );
        return EXIT.ok;
      }
      case "regenerate":
        return await regenerateCommand(options, io);
      case "approve": {
        const skillId = requireSkillId(options);
        const version = requireFlag(options.version, "--version");
        // What is approved is shown first: its text and the hash every run checks it by.
        const read = await skillsRequest(options, { action: "body", workspaceId, skillId, version }, io);
        if (!read.ok) return read.exit;
        const shown = SkillsBodyAnswerSchema.parse(read.result);
        io.stderr(`${bodyText(shown.version, shown.text, await escalationOf(options, shown, io))}\n`);
        if (!operatorTrustedProvenance(shown.version.provenance) && options.yes !== true) {
          emitError(
            io,
            `${skillId}@${version} was written by ${shown.version.provenance}, not you: read it above, then approve it with --yes`,
          );
          return EXIT.usage;
        }
        const reply = await skillsRequest(options, { action: "approve", workspaceId, skillId, version }, io);
        if (!reply.ok) return reply.exit;
        emit(io, options.format, reply.result, (result) => {
          const approved = SkillVersionSchema.parse(result);
          return `${approved.skillId}@${approved.version} approved. Make it active with tavi skills activate ${approved.skillId} --version ${approved.version}`;
        });
        return EXIT.ok;
      }
      case "reject":
      case "activate":
      case "rollback": {
        const reply = await skillsRequest(
          options,
          { action: options.action, workspaceId, skillId: requireSkillId(options), version: requireFlag(options.version, "--version") },
          io,
        );
        if (!reply.ok) return reply.exit;
        if (options.action === "reject")
          emit(io, options.format, reply.result, (result) => {
            const rejected = SkillVersionSchema.parse(result);
            return `${rejected.skillId}@${rejected.version} rejected`;
          });
        else
          emit(io, options.format, reply.result, (result) => {
            const activation = SkillActivationSchema.parse(result);
            return options.action === "activate"
              ? `${activation.skillId}@${activation.activeVersion} is active, since ${localTime(activation.activatedAt)}`
              : `${activation.skillId} rolled back: ${activation.activeVersion} is active again, since ${localTime(activation.activatedAt)}`;
          });
        return EXIT.ok;
      }
      case "disable": {
        const reply = await skillsRequest(options, { action: "disable", workspaceId, skillId: requireSkillId(options) }, io);
        if (!reply.ok) return reply.exit;
        emit(io, options.format, reply.result, () => `disabled ${options.skillId ?? ""}`);
        return EXIT.ok;
      }
    }
  } catch (error) {
    return reportRefusal(error, io, "skills command failed", SKILLS_REFUSAL_CODES);
  }
}

/** A time as the person's own clock reads it: "Tue, 03/11/2026, 16:24". */
const localTime = (at: string): string => fireTimeText(at, hostTimeZone());

/** `import`'s text: what was filed, in which state, from whom, an Agent Skills package's files and tools, and how to read it. */
function importedText(version: SkillVersion): string {
  const { files, allowedTools } = version.manifest;
  return [
    `${version.skillId}@${version.version} imported: ${version.reviewState}, from ${terminalText(version.provenance)}`,
    ...(files === undefined ? [] : [`files: ${terminalText(files.join(", "))}`]),
    ...(allowedTools === undefined ? [] : [`allowed-tools (a ceiling, not a grant): ${terminalText(declaredToolsText(allowedTools))}`]),
    `read it with tavi skills show ${version.skillId} --body --version ${version.version}`,
  ].join("\n");
}

/** `show`'s text: the skill's active version, each version on a line, then its activation history, newest first. */
function showText(skillId: string, shown: SkillsShowAnswer): string {
  const name = shown.versions[0]?.manifest.name;
  return [
    `${skillId}${name === undefined ? "" : ` (${terminalText(name)})`}: ${shown.activation === undefined ? "no version active" : `${shown.activation.activeVersion} active`}`,
    ...shown.versions.map(
      (version) =>
        `  ${version.version}\t${version.reviewState}${skillProposalExpired(version, nowTimestamp()) ? " (expired)" : ""}\timported ${localTime(version.importedAt)}, from ${terminalText(version.provenance)}`,
    ),
    ...(shown.history.length === 0
      ? []
      : ["history:", ...shown.history.map((entry) => `  ${localTime(entry.at)} · ${skillActivationHistoryText(entry)} · ${entry.actor}`)]),
  ].join("\n");
}

/** A `--package` file's bytes; a missing one is the operator's typo, said as such (exit 2), not an internal failure. */
function readPackageFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new TaviError("INVALID_INPUT", `no such file: ${path}`);
    if (code === "EISDIR")
      throw new TaviError(
        "INVALID_INPUT",
        `${path} is a folder: import an Agent Skills folder without --package (tavi skills import ${path})`,
      );
    throw error;
  }
}

/** A proposal's condensed tool trace; `undefined` (said on stderr) when it cannot be read. */
async function traceOf(
  options: ResolvedDataDirectory<SkillsCommandOptions>,
  skillId: string,
  version: string,
  io: CliIo,
): Promise<SkillsTraceAnswer | undefined> {
  const reply = await skillsRequest(options, { action: "trace", workspaceId: options.workspaceId, skillId, version }, io);
  return reply.ok ? SkillsTraceAnswerSchema.safeParse(reply.result).data : undefined;
}

function traceText(trace: SkillsTraceAnswer): string {
  if (trace.calls.length === 0) return `tool calls of task ${trace.taskId}: none kept`;
  return [
    `tool calls of task ${trace.taskId}${trace.partial ? " (as far as its history keeps them)" : ""}:`,
    ...trace.calls.map((call, index) => `  ${index + 1}. ${terminalText(skillTraceLine(call))}`),
    ...(trace.more > 0 ? [`  … and ${trace.more} more`] : []),
  ].join("\n");
}

/**
 * `regenerate`: the person's feedback on a proposal, sent as their own
 * message to the chat it came from, asking the agent to propose again. It
 * goes through the chat's own admission (`reply`), so it needs the owner.
 */
async function regenerateCommand(options: ResolvedDataDirectory<SkillsCommandOptions>, io: CliIo): Promise<number> {
  const skillId = requireSkillId(options);
  const version = requireFlag(options.version, "--version");
  const client = await connectOwnerOrReport(options.dataDirectory, ["skills", "reply"], io, EXIT);
  if (typeof client === "number") return client;
  if (client === undefined) {
    emitError(io, "tavi skills regenerate sends your feedback to the chat as a message: start `tavi serve` first");
    return EXIT.unavailable;
  }
  try {
    const read = await client.request(
      "skills",
      { action: "body", workspaceId: options.workspaceId, skillId, version },
      prefixedId("skills"),
      { timeoutMs: CONFIG_TIMEOUT_MS },
    );
    if (!read.ok) {
      return refusalExit(io, read.error, "tavi skills regenerate failed");
    }
    const proposal = SkillsBodyAnswerSchema.parse(read.result).version;
    const taskId = skillProposalChatOf(proposal);
    if (proposal.manifest.proposal === undefined || taskId === undefined) {
      emitError(io, `${skillId}@${version} was not proposed in a chat: there is no chat to send feedback to`);
      return EXIT.usage;
    }
    const clientMessageId = prefixedId("skill-feedback");
    const sent = await client.request(
      "reply",
      {
        workspaceId: options.workspaceId,
        taskId,
        text: skillRegenerateMessage(proposal, requireFlag(options.feedback, "--feedback")),
        clientMessageId,
      },
      clientMessageId,
      { timeoutMs: CONFIG_TIMEOUT_MS },
    );
    if (!sent.ok) {
      return refusalExit(io, sent.error, "the feedback was not sent");
    }
    emit(io, options.format, sent.result, () => `sent to chat ${taskId}: the agent proposes ${skillId} again there`);
    return EXIT.ok;
  } finally {
    client.close();
  }
}

/**
 * Each version with its skill's usage (`skillUsageOf`): an owner that sends no `usage` reads as never used. An agent's
 * proposal waiting past its 30 days is marked `expired`: still the person's to review, no longer counted against the cap.
 */
function listedWithUsage(
  answer: SkillsListAnswer,
  now = nowTimestamp(),
): readonly (SkillVersion & { readonly usage: SkillUseSummary; readonly expired?: true })[] {
  const usageOf = skillUsageOf(answer);
  return answer.versions.map((version) => ({
    ...version,
    usage: usageOf(version.skillId),
    ...(skillProposalExpired(version, now) ? { expired: true as const } : {}),
  }));
}

function usageText(usage: SkillUseSummary): string {
  const counted = skillUsageText(usage);
  return usage.unused ? `${counted} (unused ${SKILL_UNUSED_DAYS}+ days)` : counted;
}

/** The version a skill has active, for `show --body` without `--version`. */
async function activeVersionOf(options: ResolvedDataDirectory<SkillsCommandOptions>, skillId: string, io: CliIo): Promise<string | number> {
  const reply = await skillsRequest(options, { action: "show", workspaceId: options.workspaceId, skillId }, io);
  if (!reply.ok) return reply.exit;
  const active = SkillsShowAnswerSchema.parse(reply.result).activation?.activeVersion;
  if (active === undefined) {
    emitError(io, `${skillId} has no active version: name one with --version`);
    return EXIT.usage;
  }
  return active;
}

/**
 * How a version widens the `allowed-tools` of the version it is reviewed
 * against (`skillToolsEscalationText`): the version it follows, else the
 * skill's active one — an import names no parent. `undefined` when it widens
 * nothing, there is none to compare with, or the skill's versions cannot be read.
 */
async function escalationOf(
  options: ResolvedDataDirectory<SkillsCommandOptions>,
  answer: SkillsBodyAnswer,
  io: CliIo,
): Promise<{ readonly text: string; readonly since: string } | undefined> {
  const reply = await skillsRequest(options, { action: "show", workspaceId: options.workspaceId, skillId: answer.version.skillId }, io);
  if (!reply.ok) return undefined;
  const shown = SkillsShowAnswerSchema.parse(reply.result);
  const since = answer.parentVersion ?? shown.activation?.activeVersion;
  const against = since === answer.version.version ? undefined : shown.versions.find((version) => version.version === since);
  const text =
    against === undefined ? undefined : skillToolsEscalationText(against.manifest.allowedTools, answer.version.manifest.allowedTools);
  return text === undefined || since === undefined ? undefined : { text, since };
}

/** The names a list declares, each no Tavi tool answers to marked so. */
function declaredToolsText(names: readonly string[]): string {
  return names.map((name) => (taviToolForSkillName(name) === undefined ? `${name} (declared but not enforceable here)` : name)).join(", ");
}

/** A version's text as printed: a header with its hash, provenance and any escalation, then the text, or why there is none. */
function bodyText(version: SkillVersion, text: string | undefined, escalation?: { readonly text: string; readonly since: string }): string {
  const manifest = version.manifest;
  const untrusted = skillProposalUntrustedLine(version);
  const header = [
    `${version.skillId}@${version.version} (${version.reviewState}${skillProposalExpired(version, nowTimestamp()) ? ", expired" : ""}) sha256 ${version.contentHash}`,
    `provenance: ${version.provenance}`,
    ...(manifest.allowedTools === undefined
      ? []
      : [`allowed-tools (a ceiling, not a grant): ${terminalText(declaredToolsText(manifest.allowedTools))}`]),
    ...(escalation === undefined ? [] : [`! ${terminalText(escalation.text)} (since ${escalation.since})`]),
    ...(manifest.compatibility === undefined ? [] : [`compatibility: ${manifest.compatibility}`]),
    ...(manifest.proposal === undefined
      ? []
      : [
          `proposed by the agent${manifest.proposal.requested ? " when asked" : " on its own"}, from task ${manifest.proposal.taskId}: ${terminalText(manifest.proposal.note)}`,
        ]),
    ...(untrusted === undefined ? [] : [`! ${terminalText(untrusted)}`]),
  ].join("\n");
  // A bundle shows every file: SKILL.md first, a script as text (it is never run), bytes as their size.
  const files = text === undefined ? undefined : skillPackageFiles(text);
  const shown =
    text === undefined
      ? "(the package is not readable text)"
      : files === undefined
        ? terminalText(text)
        : // A bundle shows file by file even when it holds SKILL.md alone: never its stored JSON.
          skillBundleFilesForReview(files)
            .map((file) =>
              file.text === undefined
                ? `--- ${file.path} (${skillBundleFileBytes(file)} bytes, not text)`
                : `--- ${file.path}\n${terminalText(file.text)}`,
            )
            .join("\n\n");
  return `${header}\n\n${shown}`;
}

/** The rollout actions, on the directory itself: no owner serves them. */
async function skillsRolloutCommand(options: ResolvedDataDirectory<SkillsCommandOptions>, io: CliIo): Promise<number> {
  try {
    return await withStore(options.dataDirectory, async (store) => {
      const actor: SkillActor = {
        principalId: options.principalId,
        workspaceId: options.workspaceId,
        caller: "cli",
      };

      switch (options.action) {
        case "pin-rollout": {
          // The operator-facing surface for the bounded-rollout
          // allowlist.
          const rollout = new SkillRolloutService(store.asPort());
          const pinSkillId = requireSkillId(options);
          // `--version` pins a STORED, not-yet-active version so
          // the pin can precede `activate` — without it the
          // active version is pinned. The status
          // printed is that pinned version's own, not necessarily the
          // active one's, so an operator sees what they just did.
          await rollout.pinRollout({
            actor,
            skillId: pinSkillId,
            taskIds: options.taskIds ?? [],
            ...(options.version === undefined ? {} : { version: options.version }),
          });
          const status =
            options.version === undefined
              ? await rollout.getRolloutStatus({ actor, skillId: pinSkillId })
              : {
                  version: options.version,
                  pinned: true,
                  authorizedTaskIds: (
                    await store.asPort().repositories.skillRollout.listAllowed({
                      scopeKey: options.workspaceId,
                      skillId: pinSkillId,
                      version: options.version,
                    })
                  ).map((entry) => entry.taskId),
                };
          emit(
            io,
            options.format,
            status,
            (pinned) =>
              `${pinSkillId}@${pinned.version} pinned to ${pinned.authorizedTaskIds.join(", ")}: every other task gets no version of ${pinSkillId} until tavi skills clear-rollout ${pinSkillId} --version ${pinned.version}`,
          );
          return EXIT.ok;
        }
        case "clear-rollout": {
          const rollout = new SkillRolloutService(store.asPort());
          const skillId = requireSkillId(options);
          // `--version` targets a SPECIFIC (possibly stale/inactive)
          // version via `clearRolloutVersion`; omitted clears
          // whatever the CURRENTLY active version's own pin is, via
          // `clearRollout` — the two differ in whether an active
          // version is required to exist at all.
          if (options.version === undefined) {
            await rollout.clearRollout({ actor, skillId });
          } else {
            await rollout.clearRolloutVersion({ actor, skillId, version: options.version });
          }
          emit(io, options.format, { cleared: true }, () => "cleared");
          return EXIT.ok;
        }
        case "rollout-status": {
          const rollout = new SkillRolloutService(store.asPort());
          const skillId = requireSkillId(options);
          const active = await rollout.getRolloutStatus({ actor, skillId });
          // Every OTHER pinned version too — a status view that
          // only ever showed the active version's own pin would hide
          // exactly the stale pins this action exists to surface.
          const otherPins = (await rollout.listRolloutPins({ actor, skillId })).filter((pin) => !pin.active);
          emit(io, options.format, { active, otherPins }, (status) =>
            [
              `${skillId}@${status.active.version} (active): ${status.active.pinned ? `pinned to ${status.active.authorizedTaskIds.join(", ")}; every other task gets no version of it` : "every task gets it"}`,
              ...status.otherPins.map(
                (pin) => `${skillId}@${pin.version} (not active): still pinned to ${pin.taskCount} task${pin.taskCount === 1 ? "" : "s"}`,
              ),
            ].join("\n"),
          );
          return EXIT.ok;
        }
        default:
          io.stderr("Unsupported skills action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    return reportRefusal(error, io, "skills command failed", { usage: ["INVALID_INPUT", "REVISION_CONFLICT"], unavailable: ["NOT_FOUND"] });
  }
}

function requireSkillId(options: SkillsCommandOptions): string {
  if (options.skillId === undefined) throw new TaviError("INVALID_INPUT", "A skill id is required");
  return options.skillId;
}
