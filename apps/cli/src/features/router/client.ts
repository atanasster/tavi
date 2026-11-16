import { evaluateRouterEvidence, RouterEvaluationEvidenceSchema, routerNoEvidenceReport } from "./evaluation.js";
import { emitJson } from "../../cli/output.js";
import { EXIT, reportFailure } from "../../cli/exit.js";
import { PluginRegistry, RouterRepository, ModelAccounting } from "@tavi/runtime";
import { BUILTIN_PLUGINS } from "../plugins/catalog.js";
import { routerCommand as executeRouterCommand, routerProviderCandidate, routerProviderPricing, routerProviderState } from "./owner.js";
import { RouterPayloadSchema, TaviError } from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import type { RouterCommandOptions } from "./parse.js";
import { readFileSync, statSync } from "node:fs";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { join } from "node:path";
import { createLocalCredentialStore } from "../credentials/store.js";
import type { CliIo } from "../../cli/io.js";
import { attachToOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";

export async function routerCliCommand(options: ResolvedDataDirectory<RouterCommandOptions>, io: CliIo): Promise<number> {
  try {
    let document: unknown = {};
    if (options.file !== undefined) {
      if (statSync(options.file).size > (options.action === "evaluate" ? 8 * 1024 * 1024 : 65_536))
        throw new TaviError("INVALID_INPUT", "Router input exceeds its size limit");
      const contents = readFileSync(options.file, "utf8");
      try {
        document = JSON.parse(contents);
      } catch {
        throw new TaviError("INVALID_INPUT", "Router configuration is not valid JSON");
      }
      if (document === null || typeof document !== "object" || Array.isArray(document))
        throw new TaviError("INVALID_INPUT", "Router configuration must be an object");
    }
    if (options.action === "evaluate") {
      const evidence = options.file === undefined ? undefined : RouterEvaluationEvidenceSchema.safeParse(document);
      if (evidence !== undefined && !evidence.success)
        throw new TaviError("INVALID_INPUT", "Invalid router evaluation evidence; see evals/router/README.md");
      emitJson(io, evidence === undefined ? routerNoEvidenceReport() : evaluateRouterEvidence(evidence.data));
      return EXIT.ok;
    }
    const parsed = RouterPayloadSchema.safeParse({
      ...(document as object),
      action: options.action,
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      ...definedOnly({
        taskId: options.taskId,
        providerId: options.providerId,
        feature: options.feature,
        mode: options.mode,
        expectedRevision: options.expectedRevision,
      }),
    });
    // Schema messages name the field and rule, never a submitted value.
    if (!parsed.success)
      throw new TaviError("INVALID_INPUT", `Invalid router payload (${zodIssues(parsed.error).slice(0, 3).join("; ")}); see router --help`);
    const attached = await attachToOwner(options.dataDirectory, "router", parsed.data, io, undefined, routerRefusalExit);
    if (attached !== undefined) return attached;
    return await withStore(options.dataDirectory, async (store) => {
      const credentials = createLocalCredentialStore(options.dataDirectory);
      const registry = new PluginRegistry({ client: store, directory: join(options.dataDirectory, "plugins"), builtins: BUILTIN_PLUGINS });
      const result = await executeRouterCommand(
        {
          repository: new RouterRepository(store, () => true),
          accounting: new ModelAccounting(store.asPort()),
          readSecret: (reference) => credentials.getSecret(reference),
          now: nowTimestamp,
          providerState: async (providerId) => await routerProviderState(registry, providerId),
          providerCandidate: async (providerId) => await routerProviderCandidate(registry, providerId),
          providerPricing: async (providerId) => await routerProviderPricing(registry, providerId),
        },
        parsed.data,
      );
      emitJson(io, result);
      return EXIT.ok;
    });
  } catch (error) {
    // Said as a live owner says it, with the same exit: the operator's input is a usage error, never an internal one.
    const failure = TaviError.from(error);
    const own = routerRefusalExit(failure.code);
    if (own === undefined) return reportFailure(error, io, "router failed");
    io.stderr(`router failed: ${failure.code}: ${failure.message}\n`);
    return own;
  }
}

/** A refusal of what the operator typed — bad input, or a stale `--revision` — exits 2, with or without an owner. */
function routerRefusalExit(code: string | undefined): number | undefined {
  return code === "INVALID_INPUT" || code === "REVISION_CONFLICT" ? EXIT.usage : undefined;
}
