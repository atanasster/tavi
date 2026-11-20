import { emitJson, isTextOutput } from "../../cli/output.js";
import { EXIT, reportRefusal } from "../../cli/exit.js";
import { TaviError, type ModelsWriteResult, type ModelRole, DEFAULT_WORKSPACE_ID } from "@tavi/contracts";
import { ENCRYPTED_SECRET_FAMILY, ModelConfigService, createSessionSecretStore } from "@tavi/runtime";
import {
  connectionDocument,
  connectionRecord,
  connectionSummaries,
  discoverAndRecord,
  modelRoleOf,
  modelRolesDocument,
  probePdfAndRecord,
  probeVideoAndRecord,
  setVideoModelAndReport,
  sharedCredentialWarning,
  needsCredential,
  ownLocalCredential,
  storeLocalPlaceholder,
  storedCredentialRefs,
  testAndRecord,
  unlistedModelWarning,
} from "./actions.js";
import { definedOnly } from "@tavi/contracts/util";
import { connectionLocality } from "@tavi/agent-host/task-summarizer";
import { join, resolve } from "node:path";
import { probeVideoDecoder } from "../video/host.js";
import { modelsSuggestCommand } from "./suggest-command.js";
import { modelsSyncCommand } from "./sync-command.js";
import { defaultRuntimeFactory, type RuntimeFactory } from "../../cli/runtime-options.js";
import type { ModelsCommandOptions } from "./parse.js";
import { requireFlag } from "../../cli/flags.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";
import { privacyProblem, privateExpectation } from "@tavi/node-kit";

/**
 * `tavi models <action>`: application-owned model configuration.
 *
 * Under a live owner every action runs on it over IPC: a config edit
 * must not open the owner's database behind its back. With none, the
 * command takes the directory's exclusive ownership, as `recover` does.
 */
export async function modelsCommand(
  options: ResolvedDataDirectory<ModelsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory = defaultRuntimeFactory,
): Promise<number> {
  // A read of the connections and a call to the model resolver, never a write: its own path.
  if (options.action === "suggest") return modelsSuggestCommand(options, io);
  // It reads every model in use, routines and chats too: a whole runtime, its own path.
  if (options.action === "sync") return modelsSyncCommand(options, io, runtimeFactory);
  // Asked for by its flag, before an owner is looked for, so both paths say it alike.
  // A local connection may leave --credential out: it gets a placeholder of its own.
  if (
    options.action === "add" &&
    (options.baseUrl === undefined ||
      (options.credentialRef === undefined &&
        connectionLocality({ baseUrl: options.baseUrl, localOnly: options.localOnly === true }) !== "local"))
  ) {
    io.stderr(`${options.baseUrl === undefined ? "models add needs --base-url <url>, the provider's address" : needsCredential("add")}\n`);
    return EXIT.usage;
  }
  // Under a live owner the configuration is the owner's to change;
  // with none, the directory is opened directly.
  const onOwner = await modelsOnOwner(options, io);
  if (onOwner !== undefined) return onOwner;
  try {
    return await withStore(options.dataDirectory, async (store) => {
      const service = new ModelConfigService(store.asPort());
      switch (options.action) {
        case "list":
          return printModelsResult(options.action, await connectionSummaries(service, DEFAULT_WORKSPACE_ID), io);
        case "show":
          return printModelsResult(options.action, await connectionDocument(service, requireConnection(options)), io);
        case "add": {
          const own =
            options.credentialRef === undefined
              ? await ownLocalCredential(service, await storedCredentialRefs(options.dataDirectory), {
                  connectionId: requireConnection(options),
                  baseUrl: options.baseUrl ?? "",
                  localOnly: options.localOnly,
                })
              : undefined;
          const credentialRef = own?.credentialRef ?? requireFlag(options.credentialRef, "--credential");
          const shared = await sharedCredentialWarning(service, {
            connectionId: requireConnection(options),
            baseUrl: options.baseUrl ?? "",
            credentialRef,
          });
          const connection = await service.putConnection({
            connectionId: requireConnection(options),
            label: options.label ?? requireConnection(options),
            baseUrl: requireFlag(options.baseUrl, "--base-url"),
            credentialRef,
            ...(options.model === undefined ? {} : { defaultModel: options.model }),
            ...(options.localOnly === undefined ? {} : { localOnly: options.localOnly }),
            ...(options.headers === undefined ? {} : { headers: parseHeaders(options.headers) }),
            ...(options.pdfInput === undefined ? {} : { pdfInput: options.pdfInput }),
            ...(options.pdfEngine === undefined ? {} : { pdfEngine: options.pdfEngine === "default" ? null : options.pdfEngine }),
            ...(options.streamFirstByteSeconds === undefined
              ? {}
              : { streamFirstByteSeconds: options.streamFirstByteSeconds === "default" ? null : options.streamFirstByteSeconds }),
            ...(options.streamIdleSeconds === undefined
              ? {}
              : { streamIdleSeconds: options.streamIdleSeconds === "default" ? null : options.streamIdleSeconds }),
          });
          if (own?.placeholder === true) await storeLocalPlaceholder(options.dataDirectory, credentialRef);
          return printModelsResult(options.action, connectionRecord(connection), io, shared);
        }
        case "remove": {
          await service.removeConnection(requireConnection(options));
          return printModelsResult(options.action, { removed: requireConnection(options) }, io);
        }
        case "rebind": {
          const saved = await service.getConnection(requireConnection(options));
          const own =
            options.credentialRef === undefined
              ? await ownLocalCredential(service, await storedCredentialRefs(options.dataDirectory), saved, "rebind")
              : undefined;
          const connection = await service.rebindCredential({
            connectionId: saved.connectionId,
            credentialRef: own?.credentialRef ?? requireFlag(options.credentialRef, "--credential"),
          });
          if (own?.placeholder === true) await storeLocalPlaceholder(options.dataDirectory, own.credentialRef);
          return printModelsResult(options.action, connectionRecord(connection), io);
        }
        case "discover": {
          const credentialFile = requireFlag(options.credentialFile, "--credential-file");
          const discovered = await discoverAndRecord(service, requireConnection(options), (credentialRef) =>
            credentialResolver(credentialFile, credentialRef)(),
          );
          return printModelsResult(options.action, discovered, io);
        }
        case "video": {
          const result = await setVideoModelAndReport(service, requireConnection(options), {
            ...(options.videoEnable === undefined ? {} : { enable: options.videoEnable }),
            ...(options.videoDisable === undefined ? {} : { disable: options.videoDisable }),
            confirmed: options.yes === true,
          });
          return printModelsResult(options.action, result, io);
        }
        case "probe": {
          const resolve = (credentialRef: string) =>
            credentialResolver(requireFlag(options.credentialFile, "--credential-file"), credentialRef)();
          if (options.probe === "video") {
            const decoder = await probeVideoDecoder(options.dataDirectory);
            try {
              return printModelsResult(
                options.action,
                await probeVideoAndRecord(service, requireConnection(options), options.model, resolve, {
                  decoder,
                  workDirectory: join(options.dataDirectory, "video"),
                }),
                io,
              );
            } finally {
              await decoder.close();
            }
          }
          const result = await probePdfAndRecord(service, requireConnection(options), options.model, resolve);
          return printModelsResult(options.action, result, io);
        }
        case "test": {
          // Resolved lazily, inside the generation: a missing `--credential-file`
          // is a failed test to record, not a usage error before it.
          const result = await testAndRecord(service, requireConnection(options), options.model, (credentialRef) =>
            credentialResolver(requireFlag(options.credentialFile, "--credential-file"), credentialRef)(),
          );
          return printModelsResult(options.action, result, io);
        }
        case "roles":
          return printModelsResult(options.action, await modelRolesDocument(service, DEFAULT_WORKSPACE_ID), io);
        case "set-default": {
          const target = { connectionId: requireConnection(options), ...(options.model === undefined ? {} : { model: options.model }) };
          const value = await service.setWorkspaceDefault({ workspaceId: DEFAULT_WORKSPACE_ID, target });
          return printModelsResult(options.action, value, io, await unlistedModelWarning(service, target));
        }
        case "clear-default": {
          await service.clearWorkspaceDefault(DEFAULT_WORKSPACE_ID);
          return printModelsResult(options.action, { cleared: DEFAULT_WORKSPACE_ID }, io);
        }
        case "set-role": {
          const target = { connectionId: requireConnection(options), ...(options.model === undefined ? {} : { model: options.model }) };
          const binding = await service.setRoleBinding({
            workspaceId: DEFAULT_WORKSPACE_ID,
            role: requireRole(options),
            target,
            ...(options.fallback === undefined ? {} : { fallback: options.fallback.map(parseFallback) }),
          });
          return printModelsResult(options.action, binding, io, await unlistedModelWarning(service, target));
        }
        case "clear-role": {
          await service.clearRoleBinding(DEFAULT_WORKSPACE_ID, requireRole(options));
          return printModelsResult(options.action, { cleared: requireRole(options) }, io);
        }
        default:
          io.stderr("Unsupported models action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    // Alignment with the other commands: a refused or malformed configuration is
    // not an internal crash, and ownership contention keeps its own exit code. A
    // conflict with stored configuration — a connection a role still references —
    // is a usage-level refusal.
    return reportRefusal(error, io, "models command failed", {
      usage: ["INVALID_INPUT"],
      unavailable: ["NOT_FOUND", "NOT_CONFIGURED", "CAPABILITY_MISSING"],
    });
  }
}

/** The `models` actions that write, answered `{ result, restartRequired }` by an owner. */
const MODEL_WRITES: ReadonlySet<string> = new Set(["add", "remove", "rebind", "set-default", "clear-default", "set-role", "clear-role"]);
/** Printed compact: a removal or a cleared binding is one line. */
const COMPACT_MODEL_RESULTS: ReadonlySet<string> = new Set(["remove", "clear-default", "clear-role"]);

/** A `models` result as both paths print it, and its exit: a failed `test` is 1. `warning`: said on stderr after it. */
function printModelsResult(action: ModelsCommandOptions["action"], result: unknown, io: CliIo, warning?: string): number {
  // `--format text` prints the record as text (`emitJson`); otherwise JSON, a removal's or a cleared role's on one line.
  if (isTextOutput(io) || !COMPACT_MODEL_RESULTS.has(action)) emitJson(io, result);
  else io.stdout(`${JSON.stringify(result)}\n`);
  if (warning !== undefined) io.stderr(`${warning}\n`);
  if (action === "test" || action === "probe") return (result as { readonly ok?: boolean }).ok === true ? EXIT.ok : EXIT.taskFailed;
  return EXIT.ok;
}

/** `tavi models <action>` on a live owner: every action has an IPC counterpart. */
function modelsOnOwner(options: ResolvedDataDirectory<ModelsCommandOptions>, io: CliIo): Promise<number | undefined> {
  return configOnOwner(options.dataDirectory, "models", io, {
    label: `tavi models ${options.action}`,
    // A probe records its result in the catalog.
    mutates:
      MODEL_WRITES.has(options.action) ||
      options.action === "test" ||
      options.action === "probe" ||
      options.action === "discover" ||
      options.action === "video",
    // The PDF probe's own deadline is 30 s: the request waits past it, so its answer is the probe's.
    ...(options.action === "probe" ? { timeoutMs: 60_000 } : {}),
    build: () => {
      // `suggest` and `sync` never reach here: each has its own path (`suggest-command.ts`, `sync-command.ts`).
      if (options.action === "suggest" || options.action === "sync") return EXIT.usage;
      // The owner resolves a connection's credential through its own chain;
      // a file handed to this process would be ignored, so it is refused.
      if (options.credentialFile !== undefined) {
        io.stderr(
          `An owner is serving ${options.dataDirectory}, and it probes a connection with the credential its own chain resolves, ` +
            "so --credential-file cannot apply. Omit it, or stop `tavi serve` to probe with it.\n",
        );
        return EXIT.usage;
      }
      return {
        action: options.action,
        workspaceId: DEFAULT_WORKSPACE_ID,
        ...definedOnly({
          connectionId: options.connectionId,
          label: options.label,
          baseUrl: options.baseUrl,
          credentialRef: options.credentialRef,
          model: options.model,
          localOnly: options.localOnly,
        }),
        ...(options.headers === undefined ? {} : { headers: parseHeaders(options.headers) }),
        ...(options.pdfInput === undefined ? {} : { pdfInput: options.pdfInput }),
        ...(options.pdfEngine === undefined ? {} : { pdfEngine: options.pdfEngine }),
        ...definedOnly({ streamFirstByteSeconds: options.streamFirstByteSeconds, streamIdleSeconds: options.streamIdleSeconds }),
        ...(options.role === undefined ? {} : { role: modelRoleOf(options.role) }),
        ...(options.fallback === undefined ? {} : { fallback: options.fallback.map(parseFallback) }),
        ...definedOnly({
          videoEnable: options.videoEnable,
          videoDisable: options.videoDisable,
          disclosureConfirmed: options.yes,
          probe: options.probe,
        }),
      };
    },
    render: (result) => {
      if (!MODEL_WRITES.has(options.action)) return printModelsResult(options.action, result, io);
      // `warning`: a model the connection's catalog does not list, said by the owner beside its answer.
      const { result: written, restartRequired, warning } = result as ModelsWriteResult & { readonly warning?: string };
      const code = printModelsResult(options.action, written, io, warning);
      if (restartRequired) {
        io.stderr(
          "note: the running owner keeps the model target it resolved at startup; restart `tavi serve` for this change to take effect\n",
        );
      }
      return code;
    },
  });
}

function requireConnection(options: ModelsCommandOptions): string {
  if (options.connectionId === undefined) throw new TaviError("INVALID_INPUT", "A connection id is required");
  return options.connectionId;
}

function requireRole(options: ModelsCommandOptions): ModelRole {
  if (options.role === undefined) throw new TaviError("INVALID_INPUT", "A role is required");
  return modelRoleOf(options.role);
}

/** `key=value` pairs; the service refuses credential-bearing headers. */
function parseHeaders(headers: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const header of headers) {
    const separator = header.indexOf("=");
    if (separator <= 0) throw new TaviError("INVALID_INPUT", `--header expects key=value, received ${header}`);
    parsed[header.slice(0, separator)] = header.slice(separator + 1);
  }
  return parsed;
}

/** `connection/model` fallback syntax. */
function parseFallback(value: string): { connectionId: string; model: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new TaviError("INVALID_INPUT", `--fallback expects connection/model, received ${value}`);
  }
  return { connectionId: value.slice(0, separator), model: value.slice(separator + 1) };
}

/**
 * Resolve one credential from an explicit file for a discover/test call.
 *
 * The file is read for this call only and held in a transient store: the command
 * never writes it into configuration, and there is no ambient environment
 * fallback.
 */
function credentialResolver(file: string, credentialRef: string): () => Promise<string | null> {
  const store = createSessionSecretStore();
  if (store.access !== "read-write") throw new TaviError("INTERNAL", "The session store must be writable");
  const path = resolve(file);
  return async (): Promise<string | null> => {
    const { lstatSync, readFileSync } = await import("node:fs");
    // The same rules the credential-directory store applies: a symlink could
    // redirect the read, and a readable-by-others file is a leak the operator
    // should fix rather than something this command should quietly accept.
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      throw new TaviError("UNAVAILABLE", `Could not read the credential file: ${(error as Error).message}`, {
        details: { credentialRef },
      });
    }
    if (stats.isSymbolicLink()) {
      throw new TaviError("NOT_AUTHORIZED", "The credential file is a symlink; refusing to follow it", {
        details: { credentialRef },
      });
    }
    const shared = privacyProblem(path, stats);
    if (shared !== undefined) {
      throw new TaviError("NOT_AUTHORIZED", `The credential file is readable by other users (${shared}); ${privateExpectation("600")}`, {
        details: { credentialRef },
      });
    }
    const value = readFileSync(path, "utf8").trim();
    if (value === "") {
      throw new TaviError("UNAVAILABLE", "The credential file is empty", { details: { credentialRef } });
    }
    // Ciphertext is not a value: sent as one, it would be the key a provider
    // refuses — and the refusal recorded against the model.
    if (value.startsWith(ENCRYPTED_SECRET_FAMILY)) {
      throw new TaviError(
        "INVALID_INPUT",
        "The credential file holds an encrypted credential, not its value; give a file with the plain value, or let the credentials directory resolve it",
        { details: { credentialRef } },
      );
    }
    await store.setSecret(credentialRef, value);
    return await store.getSecret(credentialRef);
  };
}
