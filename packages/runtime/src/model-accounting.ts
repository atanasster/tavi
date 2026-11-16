import { randomUUID } from "node:crypto";
import {
  freezeModelValue,
  MAX_KEPT_MODEL_REQUESTS,
  ModelEmbedRequestSchema,
  snapshotModelRequest,
  TaviError,
  type InvocationContext,
  type ModelUsage,
  type ProviderAttempt,
  type ModelRequestRetention,
  type ModelRequest,
  type ProviderOperation,
  type ModelPort,
  type AsyncPersistencePort,
  type ModelAccountingPort,
  modelOutcomeObservation,
  thrownProviderObservation,
  type ProviderFailureClass,
  type ProviderObservation,
} from "@tavi/contracts";
import { executeProvider, type ResolvedProvider } from "./plugin-host/provider-bindings.js";
export class ModelAccounting implements ModelAccountingPort {
  readonly #port: ModelAccountingPort;
  constructor(persistence: AsyncPersistencePort) {
    this.#port = persistence.services.accounting;
  }
  reserveOperation(...args: Parameters<ModelAccountingPort["reserveOperation"]>): ReturnType<ModelAccountingPort["reserveOperation"]> {
    return this.#port.reserveOperation(...args);
  }
  finishOperation(...args: Parameters<ModelAccountingPort["finishOperation"]>): ReturnType<ModelAccountingPort["finishOperation"]> {
    return this.#port.finishOperation(...args);
  }
  operations(...args: Parameters<ModelAccountingPort["operations"]>): ReturnType<ModelAccountingPort["operations"]> {
    return this.#port.operations(...args);
  }
  putPrice(...args: Parameters<ModelAccountingPort["putPrice"]>): ReturnType<ModelAccountingPort["putPrice"]> {
    return this.#port.putPrice(...args);
  }
  price(...args: Parameters<ModelAccountingPort["price"]>): ReturnType<ModelAccountingPort["price"]> {
    return this.#port.price(...args);
  }
  begin(...args: Parameters<ModelAccountingPort["begin"]>): ReturnType<ModelAccountingPort["begin"]> {
    return this.#port.begin(...args);
  }
  beginPriced(...args: Parameters<ModelAccountingPort["beginPriced"]>): ReturnType<ModelAccountingPort["beginPriced"]> {
    return this.#port.beginPriced(...args);
  }
  finish(...args: Parameters<ModelAccountingPort["finish"]>): ReturnType<ModelAccountingPort["finish"]> {
    return this.#port.finish(...args);
  }
  get(...args: Parameters<ModelAccountingPort["get"]>): ReturnType<ModelAccountingPort["get"]> {
    return this.#port.get(...args);
  }
  list(...args: Parameters<ModelAccountingPort["list"]>): ReturnType<ModelAccountingPort["list"]> {
    return this.#port.list(...args);
  }
  summaries(...args: Parameters<ModelAccountingPort["summaries"]>): ReturnType<ModelAccountingPort["summaries"]> {
    return this.#port.summaries(...args);
  }
  usedConnections(...args: Parameters<ModelAccountingPort["usedConnections"]>): ReturnType<ModelAccountingPort["usedConnections"]> {
    return this.#port.usedConnections(...args);
  }
  usedConnectionsOf(...args: Parameters<ModelAccountingPort["usedConnectionsOf"]>): ReturnType<ModelAccountingPort["usedConnectionsOf"]> {
    return this.#port.usedConnectionsOf(...args);
  }
  costTotals(...args: Parameters<ModelAccountingPort["costTotals"]>): ReturnType<ModelAccountingPort["costTotals"]> {
    return this.#port.costTotals(...args);
  }
  recoverPreviousOwner(
    ...args: Parameters<ModelAccountingPort["recoverPreviousOwner"]>
  ): ReturnType<ModelAccountingPort["recoverPreviousOwner"]> {
    return this.#port.recoverPreviousOwner(...args);
  }
  deleteRun(...args: Parameters<ModelAccountingPort["deleteRun"]>): ReturnType<ModelAccountingPort["deleteRun"]> {
    return this.#port.deleteRun(...args);
  }
}

/** Records exactly one row per ModelPort invocation; streamed/UI usage events are not added again. */
export function accountedModelPort(
  models: ModelPort,
  ledger: ModelAccounting,
  options: {
    readonly ownerSession: string;
    readonly now: () => string;
    readonly newId?: () => string;
    readonly authorize?: (context: InvocationContext) => Promise<void>;
    readonly resolve?: (
      request: Pick<ModelRequest, "connectionId" | "model">,
      context: InvocationContext,
    ) => Promise<ResolvedProvider<ModelPort>>;
    /**
     * How many of the run's newest attempts keep their whole request,
     * read when the call settles: the workspace's `keptModelRequests`. Absent,
     * or failing, the ledger's default.
     */
    readonly keptRequests?: (context: InvocationContext | undefined) => Promise<number> | number;
    /**
     * Told how each streamed call settled, with its purpose, after it is
     * recorded and never awaited: `errorCode` is
     * the adapter's `ModelError` code, or a thrown error's `details.code`, and
     * `failure` what the failure says of the work (`ProviderFailureClass`), and
     * `usage` what the provider reported it used, when it answered. A throw here
     * never reaches the call.
     */
    readonly onSettled?: (settled: {
      readonly connectionId: string;
      readonly model: string;
      readonly purpose: ProviderAttempt["purpose"];
      readonly context: InvocationContext | undefined;
      readonly status: "completed" | "failed" | "aborted";
      readonly errorCode?: string;
      readonly failure?: ProviderFailureClass;
      readonly usage?: ModelUsage;
    }) => void;
  },
): ModelPort {
  const resolve = options.resolve;
  const tell = (
    request: Pick<ModelRequest, "connectionId" | "model" | "purpose">,
    context: InvocationContext | undefined,
    status: "completed" | "failed" | "aborted",
    errorCode: unknown,
    failure: ProviderObservation | undefined,
    usage?: ModelUsage,
  ) => {
    if (options.onSettled === undefined) return;
    try {
      options.onSettled({
        connectionId: request.connectionId,
        model: request.model,
        purpose: request.purpose ?? "generation",
        context,
        status,
        ...(typeof errorCode === "string" ? { errorCode } : {}),
        ...(failure === undefined || failure === "ok" ? {} : { failure }),
        ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
      });
    } catch {
      // An observer never fails the call it observes.
    }
  };
  const retention = async (context: InvocationContext | undefined): Promise<ModelRequestRetention | undefined> => {
    if (options.keptRequests === undefined) return undefined;
    try {
      const keptRequests = await options.keptRequests(context);
      return Number.isSafeInteger(keptRequests) && keptRequests >= 0 && keptRequests <= MAX_KEPT_MODEL_REQUESTS
        ? { keptRequests }
        : undefined;
    } catch {
      // A setting that cannot be read never fails the call it settles.
      return undefined;
    }
  };
  /**
   * One provider call, recorded once: the binding resolved and re-checked at
   * each await (`executeProvider`: binding hash, authorization, cancellation),
   * the attempt reserved with its price, and settled by the call's outcome.
   * Shared by `stream` and `embed`, so the two cannot drift.
   */
  const dispatch = async <Outcome extends { readonly status: "completed" | "failed" | "aborted"; readonly usage: ModelUsage }>(call: {
    readonly request: Pick<ModelRequest, "connectionId" | "model" | "runId" | "attemptId">;
    readonly purpose: ProviderAttempt["purpose"];
    readonly site?: ProviderAttempt["site"];
    readonly context: InvocationContext | undefined;
    readonly signal: AbortSignal;
    readonly expectedBindingHash: string | undefined;
    /** The request the ledger keeps, if any. */
    readonly kept: ModelRequest | undefined;
    /** Whether the provider has sent anything yet: a refusal before that is `failed`, not `uncertain`. */
    readonly sent: () => boolean;
    /** The call without a resolver (an in-process fixture, a test). */
    readonly direct: () => Promise<Outcome>;
    readonly invoke: (provider: ModelPort, signal: AbortSignal) => Promise<Outcome>;
  }): Promise<Outcome> => {
    const { request, context } = call;
    if (resolve !== undefined && (context === undefined || context.runId !== request.runId))
      throw new TaviError("NOT_AUTHORIZED", "Model execution requires its authenticated run context");
    const resolved = resolve === undefined || context === undefined ? undefined : await resolve(request, context);
    const callId = options.newId?.() ?? randomUUID();
    let reserved = false;
    const reserve = async (operation?: ProviderOperation) => {
      // Priced in the same request that records it: the sheet in effect when it started.
      await ledger.beginPriced({
        callId,
        runId: request.runId,
        attemptId: request.attemptId,
        ownerSession: options.ownerSession,
        ...(call.kept === undefined ? {} : { request: call.kept }),
        connectionId: request.connectionId,
        model: request.model,
        purpose: call.purpose,
        ...(call.site === undefined ? {} : { site: call.site }),
        startedAt: options.now(),
        ...(operation === undefined ? {} : { operation }),
      });
      reserved = true;
    };
    let result: Outcome;
    try {
      result =
        resolved === undefined || context === undefined
          ? await (async () => {
              await reserve();
              return call.direct();
            })()
          : await executeProvider({
              resolved,
              context,
              attemptId: request.attemptId,
              purpose: call.purpose,
              envelope: { accountingRef: callId },
              signal: call.signal,
              expectedBindingHash: call.expectedBindingHash ?? resolved.bindingHash,
              authorize: async () => {
                await options.authorize?.(context);
                // Re-resolve configuration after the caller's grant/approval await.
                const current = await resolve?.(request, context);
                if (current?.bindingHash !== resolved.bindingHash)
                  throw new TaviError("NOT_AUTHORIZED", "Model binding changed before dispatch");
                // Restart reconciliation must not resend interrupted work through a reconfigured connection.
                // Scoped to this turn: an attempt an earlier turn left unknown is not the work this
                // call would resend — the next message is new work, and resolves the route as it is now — so
                // only one started at or after this turn began holds the call back. A context from before
                // turns were stamped is held back by every such attempt of the task, as before.
                const turnStartedAt = context.turnStartedAt === undefined ? Number.NaN : Date.parse(context.turnStartedAt);
                const unresolved = (await ledger.list(request.runId, { states: ["started", "uncertain"] })).find(
                  (row) =>
                    row.operation?.binding.instanceId === resolved.binding.instanceId &&
                    row.operation.bindingHash !== resolved.bindingHash &&
                    (Number.isNaN(turnStartedAt) || !(Date.parse(row.startedAt) < turnStartedAt)),
                );
                if (unresolved !== undefined)
                  throw new TaviError(
                    "NOT_AUTHORIZED",
                    `Model connection ${request.connectionId} changed since attempt ${unresolved.attemptId}, whose outcome is unknown; send your next message to continue with the new configuration`,
                  );
              },
              reserve,
              invoke: (provider, signal) => call.invoke(provider, signal),
            });
    } catch (error) {
      // A host-side request refusal before any provider event sent nothing billable.
      const refused = !call.sent() && error instanceof TaviError && (error.code === "INVALID_INPUT" || error.code === "CAPABILITY_MISSING");
      if (reserved) await ledger.finish(callId, refused ? "failed" : "uncertain", {}, options.now(), await retention(context));
      throw error;
    }
    await ledger.finish(callId, result.status, result.usage, options.now(), await retention(context));
    return result;
  };
  return {
    ...(resolve === undefined
      ? {}
      : {
          resolveBinding: async (request: Pick<ModelRequest, "connectionId" | "model">, context: InvocationContext) => {
            const { binding, bindingHash } = await resolve(request, context);
            return { binding, bindingHash };
          },
        }),
    async stream(mutableRequest, streamOptions) {
      const request = snapshotModelRequest(mutableRequest);
      let emitted = false;
      const observed = {
        ...streamOptions,
        onEvent: (event: Parameters<typeof streamOptions.onEvent>[0]) => {
          emitted = true;
          streamOptions.onEvent(event);
        },
      };
      try {
        const outcome = await dispatch({
          request,
          purpose: request.purpose ?? "generation",
          ...(streamOptions.site === undefined ? {} : { site: streamOptions.site }),
          context: streamOptions.context,
          signal: streamOptions.signal,
          expectedBindingHash: streamOptions.expectedBindingHash,
          // A background memory call keeps no copy of what it sent, only its usage.
          kept: streamOptions.keepRequest === false ? undefined : request,
          sent: () => emitted,
          direct: () => models.stream(request, observed),
          invoke: (provider, signal) => provider.stream(request, { ...observed, signal }),
        });
        tell(request, streamOptions.context, outcome.status, outcome.error?.code, modelOutcomeObservation(outcome), outcome.usage);
        return outcome;
      } catch (error) {
        tell(
          request,
          streamOptions.context,
          streamOptions.signal.aborted ? "aborted" : "failed",
          error instanceof TaviError ? error.details?.["code"] : undefined,
          thrownProviderObservation(error),
        );
        throw error;
      }
    },
    async embed(mutableRequest, embedOptions) {
      // A frozen copy: what is checked is what is sent.
      const parsed = ModelEmbedRequestSchema.safeParse(mutableRequest);
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `Embedding request is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      const request = freezeModelValue(parsed.data);
      const refuse = (): never => {
        throw new TaviError("CAPABILITY_MISSING", `Model connection ${request.connectionId} cannot compute embeddings`);
      };
      // The ledger keeps an embedding call's usage, never its texts.
      return dispatch({
        request,
        purpose: "embedding",
        context: embedOptions.context,
        signal: embedOptions.signal,
        expectedBindingHash: embedOptions.expectedBindingHash,
        kept: undefined,
        sent: () => false,
        direct: () => (models.embed === undefined ? refuse() : models.embed(request, { signal: embedOptions.signal })),
        invoke: (provider, signal) => (provider.embed === undefined ? refuse() : provider.embed(request, { signal })),
      });
    },
  };
}
