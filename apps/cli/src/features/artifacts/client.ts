import { emit, emitJson } from "../../cli/output.js";
import { EXIT, reportFailure, reportRefusal } from "../../cli/exit.js";
import { ChatFolders, FolderSpace, createArtifactMaterializer, type MaterializeArtifact } from "@tavi/runtime";
import {
  ArtifactsResultSchema,
  type ArtifactListRow,
  TaviError,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type InvocationContext,
  decidableRound,
  expectedStepsOf,
  roundResumeKey,
  type PendingRound,
  type RoundDecidability,
} from "@tavi/contracts";
import type { TaviRuntime } from "../../runtime/types.js";
import { artifactProblem, undecidableRoundMessage } from "../../shared/rounds.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { homedir } from "node:os";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { reviewOnOwner } from "../run/attached.js";
import type { ArtifactsCommandOptions } from "./parse.js";
import { requireFlag } from "../../cli/flags.js";
import type { CliIo } from "../../cli/io.js";
import { clientOperationKey, refuseReservedOperationKey } from "../../cli/operation-key.js";
import { configOnOwner, expectTargetOf, ownerRefusesDecisionFlags } from "../../cli/owner.js";
import { type RuntimeFactory, runtimeOptionsFor } from "../../cli/runtime-options.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";
import { foregroundStream, reportAdmitFailure, reportOutcome } from "../run/foreground.js";
import { onInterrupt } from "../../shared/interrupt.js";

/**
 * `tavi artifacts approve|reject [--resume]` against a live owner — or
 * `undefined` when none is running, so the caller decides against the directory.
 */
async function artifactOnOwner(
  options: ResolvedDataDirectory<ArtifactsCommandOptions>,
  artifactId: string,
  io: CliIo,
): Promise<number | undefined> {
  const commands = options.resume ? ["review", "subscribe", "tasks", "approvals"] : ["review"];
  const client = await connectOwnerOrReport(options.dataDirectory, commands, io, EXIT);
  if (client === undefined || typeof client === "number") return client;
  try {
    // Only a resume uses them, as offline, where a plain decision ignores them.
    if (options.resume) {
      const refused = ownerRefusesDecisionFlags(options, io);
      if (refused !== undefined) return refused;
    }
    return await reviewOnOwner(
      client,
      {
        artifactId,
        verdict: options.action === "reject" ? "reject" : "approve",
        reviewedBy: options.reviewedBy,
        resume: options.resume,
        ...expectTargetOf(options),
      },
      { format: options.format, approval: "ask", workspaceId: options.workspaceId, principalId: options.reviewedBy, exit: EXIT, io },
    );
  } finally {
    client.close();
  }
}

function writeArtifactRows(io: CliIo, format: ArtifactsCommandOptions["format"], rows: readonly ArtifactListRow[]): void {
  emit(io, format, rows, (values) =>
    values.length === 0
      ? "(no pending artifacts)"
      : values.map((row) => `${row.artifactId}\t${row.contentType}\t${row.byteSize}B\t${row.runId ?? "(no task)"}`).join("\n"),
  );
}

export async function artifactsCommand(
  options: ResolvedDataDirectory<ArtifactsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  // Under a live owner a decision is the owner's to record, and its resume the
  // owner's to admit; with none, the directory is opened
  // directly. Lists use bounded metadata pages on either path.
  if ((options.action === "approve" || options.action === "reject") && options.artifactId !== undefined) {
    if (options.resume) {
      const reserved = refuseReservedOperationKey(options.operationKey, io);
      if (reserved !== undefined) return reserved;
    }
    const onOwner = await artifactOnOwner(options, options.artifactId, io);
    if (onOwner !== undefined) return onOwner;
  }
  if (options.resume) {
    return artifactsResumeCommand(options, io, runtimeFactory);
  }
  if (options.action === "list") {
    const attached = await configOnOwner(options.dataDirectory, "artifacts", io, {
      label: "tavi artifacts list",
      mutates: false,
      build: () => ({ workspaceId: options.workspaceId, limit: Math.min(100, options.limit) }),
      render: async (result, client) => {
        let page = ArtifactsResultSchema.parse(result);
        const rows = [...page.rows];
        while (page.nextCursor && rows.length < options.limit) {
          const response = await client.request(
            "artifacts",
            { workspaceId: options.workspaceId, limit: Math.min(100, options.limit - rows.length), cursor: page.nextCursor },
            prefixedId("artifacts"),
          );
          if (!response.ok) {
            io.stderr(`${response.error?.message ?? "Artifact list refused"}\n`);
            return EXIT.unavailable;
          }
          page = ArtifactsResultSchema.parse(response.result);
          rows.push(...page.rows);
        }
        writeArtifactRows(io, options.format, rows);
        return EXIT.ok;
      },
    });
    if (attached !== undefined) return attached;
  }
  try {
    return await withStore(options.dataDirectory, async (store) => {
      const artifacts = store.asPort().repositories.artifacts;

      switch (options.action) {
        case "list": {
          const rows: ArtifactListRow[] = [];
          let cursor: string | undefined;
          do {
            const page = await store.listArtifacts({
              workspaceId: options.workspaceId,
              limit: Math.min(100, options.limit - rows.length),
              ...(cursor ? { cursor } : {}),
            });
            rows.push(...page.rows);
            cursor = page.nextCursor;
          } while (cursor && rows.length < options.limit);
          writeArtifactRows(io, options.format, rows);
          return EXIT.ok;
        }
        case "approve":
        case "reject": {
          // With no owner, the copy into the chat's folder is made here;
          // only the managed folder is used, so no `--fs-root` is needed. It
          // keeps to the free-space floor and the default budget: a served
          // owner's `--folder-cap`/`--chats-cap`/`--free-space-floor` are not recorded.
          const repositories = store.asPort().repositories;
          const materialize = createArtifactMaterializer({
            artifacts,
            folders: new ChatFolders({
              dataDirectory: options.dataDirectory,
              fsRoots: [],
              homeDirectory: homedir(),
              repository: repositories.taskFolders,
              tasks: repositories.tasks,
              agentDelegations: repositories.agentDelegations,
            }),
            space: new FolderSpace({ dataDirectory: options.dataDirectory }),
          });
          const decided = await decideArtifact(artifacts, options, materialize, io);
          emitJson(io, decided);
          return EXIT.ok;
        }
        default:
          io.stderr("Unsupported artifacts action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    return mapArtifactsError(error, io);
  }
}

/**
 * The `approve`/`reject` decision itself — a durable, CAS-protected
 * `setReviewState` write. Shared by the plain decide-only path and
 * `artifactsResumeCommand`, since re-admitting the suspended task is a
 * separate concern layered on top of the same decision.
 */
async function decideArtifact(
  artifacts: ArtifactRepositoryPort,
  options: Pick<ArtifactsCommandOptions, "action" | "artifactId" | "workspaceId" | "reviewedBy">,
  materialize: MaterializeArtifact,
  io: CliIo,
): Promise<ArtifactRecord> {
  const artifactId = requireFlag(options.artifactId, "artifact id");
  // `--workspace` is checked, not merely accepted-and-ignored:
  // `setReviewState` itself has no workspace concept (an artifact id is
  // globally unique), so without this check the flag would silently do
  // nothing — an operator who typed the wrong `--workspace` would get no
  // error and decide the artifact anyway.
  const current = await artifacts.getArtifact(artifactId);
  const problem = artifactProblem(artifactId, current, options.workspaceId);
  if (problem !== undefined) throw new TaviError(problem.code, problem.message);
  // Approving an approved artifact is still refused below, but first retries a copy into its chat's folder that failed.
  if (options.action === "approve" && current?.reviewState === "approved") {
    const copied = await materialize(artifactId);
    if (copied.status === "failed")
      io.stderr(`Artifact ${artifactId} is approved, but not copied into its chat's folder: ${copied.reason}\n`);
  }
  await artifacts.setReviewState({
    artifactId,
    reviewState: options.action === "approve" ? "approved" : "rejected",
    reviewedBy: options.reviewedBy,
    reviewedAt: nowTimestamp(),
  });
  const decided = await artifacts.getArtifact(artifactId);
  if (decided === undefined) {
    throw new TaviError("INTERNAL", "setReviewState() succeeded but the artifact could not be re-read");
  }
  // An approved download or report is copied into its chat's folder; a
  // copy that fails is said, and the decision stands.
  if (decided.reviewState === "approved") {
    const copied = await materialize(artifactId);
    if (copied.status === "failed")
      io.stderr(`Artifact ${artifactId} was approved, but not copied into its chat's folder: ${copied.reason}\n`);
  }
  return decided;
}

function mapArtifactsError(error: unknown, io: CliIo): number {
  // A missing artifact is a missing resource even though its id came from a
  // positional; one that already has a terminal review state (CONFLICT) is a
  // usage error — nothing is left to decide.
  return reportRefusal(error, io, "artifacts command failed", { usage: ["INVALID_INPUT"], unavailable: ["NOT_FOUND"] });
}

/**
 * `tavi artifacts approve|reject --resume`: record the decision, then
 * re-admit the specific task suspended on it (`kind: "approval"`, `resume:
 * { reviewAck: true }` against the artifact's own `runId`) and report the
 * outcome the same way `tavi run` does.
 *
 * Unlike the plain decide-only path (`withStore`, a bare `DatabaseClient`),
 * resuming may call the model for the task's next turn, so this composes a
 * full `TaviRuntime` with `requireModelTransport: true` — the same
 * `--connection`/`--model`/`--api-key-file` explicit-binding discipline
 * `tavi run` uses, and deliberately not shared credential state across CLI
 * invocations.
 */
async function artifactsResumeCommand(
  options: ResolvedDataDirectory<ArtifactsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  const connectionId = options.connectionId;
  const model = options.model;
  if (connectionId === undefined || model === undefined) {
    // `parseArtifacts` already enforces this from the CLI; guarded again
    // here so a caller-constructed `ArtifactsCommandOptions` (e.g. a
    // hand-built test options object) fails clearly instead of reaching
    // `runtimeOptionsFor` with `undefined`.
    io.stderr("--connection and --model are required with --resume\n");
    return EXIT.usage;
  }
  // Before the runtime and before `decideArtifact`'s durable write below.
  const reserved = refuseReservedOperationKey(options.operationKey, io);
  if (reserved !== undefined) return reserved;

  let runtime: TaviRuntime;
  try {
    runtime = await runtimeFactory(
      runtimeOptionsFor({
        prompt: "",
        format: options.format,
        workspaceId: options.workspaceId,
        principalId: options.reviewedBy,
        connectionId,
        model,
        ...(options.apiKeyFile === undefined ? {} : { apiKeyFile: options.apiKeyFile }),
        dataDirectory: options.dataDirectory,
        approval: "approve",
        quiet: false,
        inMemory: false,
      }),
      { requireModelTransport: true },
    );
  } catch (error) {
    return reportFailure(error, io, "runtime composition failed");
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new Error("interrupted by signal"));
  const stopListening = onInterrupt(onSignal);

  try {
    const workflow = runtime.workflow;
    if (workflow === undefined || !runtime.host.admissionOpen) {
      io.stderr("Runtime admission is closed: the workflow service is unavailable\n");
      return EXIT.unavailable;
    }

    const artifacts = runtime.store.asPort().repositories.artifacts;
    let decided: ArtifactRecord;
    try {
      decided = await decideArtifact(artifacts, options, runtime.materializeArtifact, io);
    } catch (error) {
      return mapArtifactsError(error, io);
    }
    emitJson(io, decided);

    if (decided.runId === null) {
      // A real, disclosed edge case: not every artifact is created inside
      // a suspended task (an internal producer may set no `runId` at
      // all). Nothing to resume — reported honestly rather than treated
      // as a failure, since the decision itself already succeeded, but
      // with a distinct exit code from `EXIT.ok` (a resume that actually
      // completed) so a `--resume` caller can tell the two apart rather
      // than only from stderr text.
      io.stderr(`Artifact ${decided.artifactId} has no associated task; nothing to resume.\n`);
      return EXIT.resumeNotApplicable;
    }
    const taskId = decided.runId;

    const context: InvocationContext = { workspaceId: options.workspaceId, principalId: options.reviewedBy, caller: "cli", runId: taskId };
    const denied = runtime.access.authorize(context, ["runs.create", "models.invoke"]);
    if (denied !== undefined) {
      io.stderr(`Not authorized: ${JSON.stringify(denied.details ?? {})}\n`);
      return EXIT.unavailable;
    }

    // Acknowledged under the review suspension's own key with the round as its
    // precondition, exactly as an approval is: every front end resuming
    // one suspension converges on one admission. A supplied `--operation-key`
    // stays the idempotency key, so a scripted retry replays its first
    // acknowledgement. Checked before the stream is attached, so this early
    // return leaves nothing to detach or flush.
    const repositories = runtime.store.asPort().repositories;
    const operationKeyFor = (round: PendingRound): string =>
      options.operationKey === undefined ? roundResumeKey(taskId, round) : clientOperationKey(options.operationKey);
    const current = await repositories.tasks.get(taskId);
    const decidability: RoundDecidability =
      current === undefined ? { decidable: false, reason: "no-round" } : await decidableRound(repositories, current, operationKeyFor);
    const round = decidability.decidable ? decidability.round : undefined;
    if (round === undefined || round.kind !== "review") {
      const why = decidability.decidable
        ? `task ${taskId} has no pending review; nothing to decide`
        : undecidableRoundMessage(taskId, decidability, "review");
      io.stderr(`${why}. The artifact decision is recorded; there is nothing to resume.\n`);
      return EXIT.resumeNotApplicable;
    }

    // Rendered from the bus, as `tavi run` is: one producer for every front end.
    const view = foregroundStream(runtime, options.format, io);
    const { renderer, stream } = view;
    stream.attach(taskId);
    try {
      const resumed = await workflow.admit(
        {
          context,
          taskId,
          operationKey: operationKeyFor(round),
          kind: "approval",
          resume: { reviewAck: true, ...expectedStepsOf(round) },
        },
        { signal: controller.signal },
      );
      renderer.finish();
      return reportOutcome(resumed.outcome, resumed.taskId, io, options.format);
    } catch (error) {
      renderer.finish();
      return await reportAdmitFailure(error, taskId, repositories.tasks, io, "resume failed", view);
    } finally {
      stream.detach();
    }
  } finally {
    stopListening();
    await runtime.close();
  }
}
