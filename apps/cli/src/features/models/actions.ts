import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MODEL_ROLES,
  TOOL_DOCUMENT_KEY,
  TOOL_VIDEO_KEY,
  LOCAL_NO_KEY_CREDENTIAL,
  TaviError,
  presetOf,
  presetVideoNever,
  videoDisclosure,
  withOwnedCapabilities,
  VIDEO_PROBED_CAPABILITY,
  type ModelConnection,
  type ModelRole,
  type VideoDecoderPort,
} from "@tavi/contracts";
import { assertModelSpecification, createAiSdkModelAdapter, providerConnectionOf } from "@tavi/agent-host/models";
import { connectionLocality } from "@tavi/agent-host/task-summarizer";
import { nearestOf } from "../../shared/nearest.js";
import { createLocalCredentialStore, listCredentialRefs } from "../credentials/store.js";
import type { ModelConfigPort as ModelConfigService } from "@tavi/contracts";
import { definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import {
  DISCOVERY_CAPABILITIES,
  discoverModels,
  isDiscoveryStale,
  OBSERVED_CAPABILITIES,
  sanitizeFailureMessage,
  testConnection,
} from "@tavi/runtime";

/**
 * The `tavi models` actions whose result is more than one service call — shared
 * by the offline command and the owner's IPC handler, so
 * an attached caller cannot receive a different answer than an unattached one.
 *
 * Only the credential differs: the offline command reads it from
 * `--credential-file`, the owner from its own credential chain — the one its
 * runs resolve through. Neither path ever returns the value.
 */

/** Resolves a credential reference to its value — what the model transport and discovery call. */
export type CredentialResolver = (credentialRef: string) => Promise<string | null>;

/**
 * A role name, refused as `INVALID_INPUT` when it is not one of the roles:
 * unchecked, it reached the store's CHECK constraint and surfaced as an
 * internal failure.
 */
export function modelRoleOf(role: string): ModelRole {
  if (!(MODEL_ROLES as readonly string[]).includes(role)) {
    throw new TaviError("INVALID_INPUT", `unknown role ${JSON.stringify(role)}; expected one of ${MODEL_ROLES.join(", ")}`);
  }
  return role as ModelRole;
}

/**
 * A connection as `models add`, `rebind` and `show` print it: the stored record
 * and `local`, what Tavi treats it as — `localOnly` as declared, or an address
 * on this computer (a loopback or unix-socket endpoint), which counts as local unasked.
 */
export function connectionRecord(connection: ModelConnection): ModelConnection & { readonly local: boolean } {
  return { ...connection, local: connectionLocality(connection) === "local" };
}

/**
 * `set-default` and `set-role` save a model the connection's catalog does not
 * list — a model typed by hand is allowed, and a catalog can be behind — but
 * say so, with the nearest listed id, so a typo shows now rather than in a
 * chat that fails later. Nothing when the connection was never discovered.
 */
export async function unlistedModelWarning(
  service: ModelConfigService,
  target: { readonly connectionId: string; readonly model?: string | undefined },
): Promise<string | undefined> {
  if (target.model === undefined) return undefined;
  const listed = (await service.listCatalog(target.connectionId)).map((entry) => entry.modelId);
  if (listed.length === 0 || listed.includes(target.model)) return undefined;
  const near = nearestOf(target.model, listed);
  const shown = listed.length <= 5 ? listed.join(", ") : `${listed.slice(0, 5).join(", ")} and ${listed.length - 5} more`;
  return (
    `warning: ${target.connectionId} does not list the model ${target.model}` +
    (near === undefined ? ` (it lists ${shown}).` : `; did you mean ${near}?`) +
    ` Check it with \`tavi models test ${target.connectionId} --model ${target.model}\``
  );
}

/** `models add` or `rebind` with no `--credential` on a connection that is not local. */
export function needsCredential(action: "add" | "rebind"): string {
  return (
    `models ${action} needs --credential <name>, a key stored with \`tavi credentials set <name> --file <path>\`; ` +
    "only a local connection (an address on this computer, or --local-only) may leave it out"
  );
}

/**
 * The credential a local connection added (or rebound) without `--credential`
 * names, as `tavi setup model` gives Ollama and LM Studio: a key already
 * stored under the connection's own id that no other connection names, else a
 * placeholder (`LOCAL_NO_KEY_CREDENTIAL`) stored under the first free
 * `<id>`, `<id>-2`, … — one per connection, so two local connections never
 * share a key across addresses; a connection already saved keeps its own.
 * `placeholder`: the caller stores `LOCAL_NO_KEY_CREDENTIAL` under it once the
 * connection is saved. A connection that is not local is refused.
 */
export async function ownLocalCredential(
  service: Pick<ModelConfigService, "listConnections">,
  storedRefs: readonly string[],
  connection: { readonly connectionId: string; readonly baseUrl: string; readonly localOnly?: boolean | undefined },
  action: "add" | "rebind" = "add",
): Promise<{ readonly credentialRef: string; readonly placeholder: boolean }> {
  if (connectionLocality({ baseUrl: connection.baseUrl, localOnly: connection.localOnly === true }) !== "local")
    throw new TaviError("INVALID_INPUT", needsCredential(action));
  const connections = await service.listConnections();
  const saved = connections.find((other) => other.connectionId === connection.connectionId);
  // An add that updates a saved connection keeps its key; a rebind is asked for a key of its own.
  if (action === "add" && saved !== undefined) return { credentialRef: saved.credentialRef, placeholder: false };
  const named = new Set(connections.filter((other) => other !== saved).map((other) => other.credentialRef));
  const stored = new Set(storedRefs);
  if (stored.has(connection.connectionId) && !named.has(connection.connectionId))
    return { credentialRef: connection.connectionId, placeholder: false };
  let candidate = connection.connectionId;
  for (let suffix = 2; stored.has(candidate) || named.has(candidate); suffix += 1)
    candidate = `${connection.connectionId}-${String(suffix)}`;
  return { credentialRef: candidate, placeholder: true };
}

/** Every reference the credential store holds, usable or not: a placeholder is never written over one. */
export async function storedCredentialRefs(dataDirectory: string): Promise<readonly string[]> {
  const { valid, invalid } = await listCredentialRefs(dataDirectory);
  return [...valid, ...invalid];
}

/** A local connection's placeholder key (`ownLocalCredential`), stored as `tavi setup model` stores one. */
export async function storeLocalPlaceholder(dataDirectory: string, credentialRef: string): Promise<void> {
  await createLocalCredentialStore(dataDirectory).setSecret(credentialRef, LOCAL_NO_KEY_CREDENTIAL);
}

/**
 * `models add` naming a key another connection uses at another address: saved
 * (chats send it to each), but said, since while an owner runs `models test`
 * refuses to send a key shared across addresses (a confused-deputy guard).
 */
export async function sharedCredentialWarning(
  service: Pick<ModelConfigService, "listConnections">,
  added: { readonly connectionId: string; readonly baseUrl: string; readonly credentialRef: string },
): Promise<string | undefined> {
  const origin = originOf(added.baseUrl);
  const other = (await service.listConnections()).find(
    (connection) =>
      connection.connectionId !== added.connectionId &&
      connection.credentialRef === added.credentialRef &&
      originOf(connection.baseUrl) !== origin,
  );
  if (other === undefined) return undefined;
  return (
    `warning: credential ${added.credentialRef} is also used by the connection ${other.connectionId} at ${originOf(other.baseUrl)}; ` +
    "while `tavi serve` runs, `tavi models test` refuses a key shared across addresses, so give this connection a credential " +
    "of its own (`tavi credentials set <name> --file <path>`, then `tavi models rebind <id> --credential <name>`)"
  );
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The model connections that name `reference`, sorted: a deleted key leaves each unable to call its model. */
export async function connectionsNaming(
  service: Pick<ModelConfigService, "listConnections">,
  reference: string,
): Promise<readonly string[]> {
  return (await service.listConnections())
    .filter((connection) => connection.credentialRef === reference)
    .map((connection) => connection.connectionId)
    .sort();
}

/**
 * `models list`: every connection, as configuration — never a credential value.
 * `defaultModel` is the connection's own, else the workspace default's model
 * when that runs on it (`tavi setup` and `set-default` set only the workspace's);
 * `workspaceDefault` marks the connection the workspace default runs on.
 */
export async function connectionSummaries(service: ModelConfigService, workspaceId: string): Promise<readonly Record<string, unknown>[]> {
  const workspaceDefault = (await service.getWorkspaceDefault(workspaceId))?.target;
  return (await service.listConnections()).map((connection) => ({
    connectionId: connection.connectionId,
    label: connection.label,
    kind: connection.kind,
    ...(connection.providerBinding === undefined ? {} : { providerBinding: connection.providerBinding }),
    baseUrl: connection.baseUrl,
    credentialRef: connection.credentialRef,
    localOnly: connection.localOnly,
    local: connectionLocality(connection) === "local",
    defaultModel: connection.defaultModel ?? (workspaceDefault?.connectionId === connection.connectionId ? workspaceDefault.model : null),
    workspaceDefault: workspaceDefault?.connectionId === connection.connectionId,
    ...(connection.videoModels === undefined ? {} : { videoModels: connection.videoModels }),
    // Sign in with ChatGPT's connection speaks the Responses API; the rest, Chat Completions.
    ...(connection.wireApi === undefined ? {} : { wireApi: connection.wireApi }),
  }));
}

/** `models show`: the connection and its catalog, each entry marked stale if the connection changed since. */
export async function connectionDocument(service: ModelConfigService, connectionId: string): Promise<Record<string, unknown>> {
  const connection = await service.getConnection(connectionId);
  return {
    connection: connectionRecord(connection),
    catalog: (await service.listCatalog(connection.connectionId)).map((entry) => ({
      ...entry,
      // Discovery describes the connection as it was: an edit since then makes
      // the listing stale even though the rows remain.
      stale: isDiscoveryStale(entry, connection),
    })),
  };
}

/** Why a role resolves to nothing: the refusals `resolveRole` makes for configuration, not faults. */
const UNRESOLVED_CODES: ReadonlySet<string> = new Set(["NOT_CONFIGURED", "CAPABILITY_MISSING"]);

/**
 * `models roles`: the workspace default, every role binding, and `resolved` —
 * what role resolution (`resolveRole`) gives each role in this workspace: its
 * binding's first usable target, else the workspace's default, else the typed
 * refusal. It is the role configuration's answer, not a run's: `tavi run` and
 * `tavi serve` resolve their target without roles today. A fault that
 * is not a refusal — an unreadable store — is thrown, not listed per role.
 */
export async function modelRolesDocument(service: ModelConfigService, workspaceId: string): Promise<Record<string, unknown>> {
  return {
    workspaceDefault: (await service.getWorkspaceDefault(workspaceId)) ?? null,
    roles: await service.listRoleBindings(workspaceId),
    resolved: await Promise.all(
      MODEL_ROLES.map(async (role) => {
        try {
          const resolution = await service.resolveRole({ workspaceId, role });
          return {
            role,
            source: resolution.source,
            target: resolution.target,
            ...(resolution.skipped.length === 0 ? {} : { skipped: resolution.skipped }),
          };
        } catch (error) {
          if (!(error instanceof TaviError) || !UNRESOLVED_CODES.has(error.code)) throw error;
          const skipped = error.details?.["skipped"];
          return {
            role,
            source: null,
            error: { code: error.code, message: error.message, ...(skipped === undefined ? {} : { skipped }) },
          };
        }
      }),
    ),
  };
}

/**
 * `models discover`: list the connection's models and record them.
 *
 * Discovery replaces the *list* but not what a test observed: a model already
 * proven capable stays capable, and a manual display name is kept, because the
 * listing says nothing new about either.
 */
export async function discoverAndRecord(
  service: ModelConfigService,
  connectionId: string,
  readSecret: CredentialResolver,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<{ readonly connectionId: string; readonly models: Awaited<ReturnType<typeof discoverModels>> }> {
  const connection = await service.getConnection(connectionId);
  if (connection.providerBinding !== undefined) return { connectionId, models: await service.listCatalog(connectionId) };
  const existing = new Map((await service.listCatalog(connection.connectionId)).map((entry) => [entry.modelId, entry]));
  const discovered = await discoverModels({
    connection,
    readSecret,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  await service.replaceCatalog(
    connection.connectionId,
    discovered.map((entry) => {
      const known = existing.get(entry.modelId);
      const displayName = entry.displayName ?? known?.displayName;
      return {
        modelId: entry.modelId,
        provenance: entry.provenance,
        state: known?.state === "capable" ? "capable" : entry.state,
        // The catalog's own tokens (`video`) are this listing's, set or cleared; a test's and a probe's are kept.
        capabilities: withOwnedCapabilities(known?.capabilities ?? [], DISCOVERY_CAPABILITIES, entry.capabilities),
        ...definedOnly({
          displayName,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          discoveredAt: entry.discoveredAt,
        }),
      };
    }),
  );
  return { connectionId: connection.connectionId, models: discovered };
}

/**
 * `models test`: one real generation against the connection, recorded.
 *
 * A successful test is what makes a catalog row `capable`; a failed one records
 * that the model is not usable right now, so the capability gate in
 * `resolveRole` stops sending work to it. A missing or malformed model id is
 * `INVALID_INPUT`, before anything is called.
 */
export async function testAndRecord(
  service: ModelConfigService,
  connectionId: string,
  model: string | undefined,
  readSecret: CredentialResolver,
  /** The test's deadline; `testConnection`'s default unless a test shortens it. */
  timeoutMs?: number,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<Awaited<ReturnType<typeof testConnection>>> {
  const connection = await service.getConnection(connectionId);
  if (connection.providerBinding !== undefined)
    throw new TaviError(
      "CAPABILITY_MISSING",
      "Provider-managed connections use approved task execution for live qualification; models test supports builtin connections",
    );
  // Before the test, not inside it: a test catches every failure of its
  // generation and records the model `unavailable`, and an install whose
  // provider speaks another specification says nothing about the model.
  assertModelSpecification();
  const modelId = modelIdFor(connection, model, "models test");
  const result = await testConnection({
    connection,
    modelId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    generate: async (input) => {
      const adapter = createAiSdkModelAdapter({
        // The connection as serve sends on it; the probe names no document, so its PDF input changes nothing here.
        connections: [providerConnectionOf(connection)],
        readSecret,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      let streamed = false;
      // Unique per attempt: an owner is long-lived and may run tests concurrently.
      const attempt = randomUUID();
      const outcome = await adapter.stream(
        {
          connectionId: connection.connectionId,
          model: modelId,
          runId: `models-test-${attempt}`,
          attemptId: `models-test-${attempt}`,
          attemptNumber: 1,
          messages: [{ id: "probe", role: "user", text: input.prompt, createdAt: nowTimestamp() }],
          // The probe tool, so a model that can call tools is recorded as able to.
          tools: [...input.tools],
          maxOutputTokens: input.maxOutputTokens,
        },
        {
          // The test's own deadline: a provider that accepts and then stalls
          // cannot hold the command — or, under an owner, a request — open.
          signal: input.signal,
          onEvent: (event) => {
            if (event.type === "text.delta") streamed = true;
          },
        },
      );
      if (outcome.status !== "completed") {
        throw new TaviError("MODEL_FAILED", outcome.error?.message ?? "the test generation failed", {
          details: { code: outcome.error?.code ?? "unknown" },
        });
      }
      return { text: outcome.text, toolCallNames: outcome.toolCalls.map((call) => call.name), streamed };
    },
  });
  // A transient failure is not recorded: marked unavailable, the model would be skipped by every run until tested again.
  if (!result.ok && result.transient === true) return result;
  // The test's own tokens are replaced; the catalog's `video` and a probe's `video-probed` stay.
  const before = (await service.listCatalog(connection.connectionId)).find((entry) => entry.modelId === modelId);
  await service.putCatalogEntry({
    connectionId: connection.connectionId,
    modelId,
    provenance: "live",
    state: result.ok ? "capable" : "unavailable",
    capabilities: withOwnedCapabilities(before?.capabilities ?? [], OBSERVED_CAPABILITIES, result.capabilities),
    discoveredAt: result.testedAt,
    ...(before?.displayName === undefined ? {} : { displayName: before.displayName }),
    ...(before?.contextWindow === undefined ? {} : { contextWindow: before.contextWindow }),
    ...(before?.maxTokens === undefined ? {} : { maxTokens: before.maxTokens }),
  });
  return result;
}

/** What `models probe --pdf` found: whether the model read the code the PDF holds, and the connection's PDF input after it. */
export interface PdfProbeResult {
  readonly connectionId: string;
  readonly modelId: string;
  readonly ok: boolean;
  readonly pdfInput: "none" | "openai-file";
  readonly latencyMs: number;
  /** Safe failure summary: never the request or a credential. */
  readonly message?: string;
}

/** The probe's code: letters and digits a model cannot confuse (no 0/O, 1/I/L). */
const PROBE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PROBE_TIMEOUT_MS = 30_000;

/**
 * A one-page PDF that says `Probe code: <code>`, written by hand: the probe
 * needs no PDF library, and nothing but the code is in it.
 */
export function probePdf(code: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (Probe code: ${code}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/**
 * `models probe --pdf`: a generated
 * one-page PDF with a random code is sent as the file a `pdf.view` result
 * names, and the model must quote the code back. A pass turns the
 * connection's PDF input on (`confirmPdfInput`); a fail leaves it as it was.
 * An endpoint that drops files (Anthropic's compatibility layer) is refused
 * before anything is sent.
 */
export async function probePdfAndRecord(
  service: ModelConfigService,
  connectionId: string,
  model: string | undefined,
  readSecret: CredentialResolver,
  options: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
): Promise<PdfProbeResult> {
  const connection = await service.getConnection(connectionId);
  if (connection.providerBinding !== undefined)
    throw new TaviError(
      "CAPABILITY_MISSING",
      "Provider-managed connections take no PDF probe; models probe --pdf supports builtin connections",
    );
  if (presetOf(connection.baseUrl)?.pdfNever === true)
    throw new TaviError(
      "UNSUPPORTED",
      `Connection ${connectionId}'s endpoint drops PDF file parts; PDFs reach it as text and rendered pages`,
    );
  assertModelSpecification();
  const modelId = modelIdFor(connection, model, "models probe --pdf");
  const code = Array.from({ length: 8 }, () => PROBE_ALPHABET[randomInt(PROBE_ALPHABET.length)]).join("");
  const document = probePdf(code);
  const adapter = createAiSdkModelAdapter({
    // Sent as a capable connection would send it: the probe is what says whether it is one.
    connections: [{ ...providerConnectionOf(connection), pdfInput: "openai-file" }],
    readSecret,
    supportsImages: () => true,
    resolveDocument: (artifactId) => (artifactId === "probe" ? { mediaType: "application/pdf", data: document } : undefined),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const attempt = randomUUID();
  const at = nowTimestamp();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  let ok = false;
  let message: string | undefined;
  try {
    const outcome = await adapter.stream(
      {
        connectionId: connection.connectionId,
        model: modelId,
        runId: `models-probe-${attempt}`,
        attemptId: `models-probe-${attempt}`,
        attemptNumber: 1,
        messages: [
          {
            id: "ask",
            role: "user",
            text: "This connection is being checked for PDF input. Read the PDF the tool returned and reply with the probe code printed in it, and nothing else.",
            createdAt: at,
          },
          { id: "call", role: "assistant", text: "", createdAt: at, toolCalls: [{ id: "probe-view", name: "pdf.view", input: {} }] },
          {
            id: "result",
            role: "tool",
            text: "",
            createdAt: at,
            toolResults: [
              {
                toolCallId: "probe-view",
                toolName: "pdf.view",
                isError: false,
                output: { document: { pageCount: 1 }, [TOOL_DOCUMENT_KEY]: { artifactId: "probe", mediaType: "application/pdf" } },
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 512,
      },
      { signal: controller.signal, onEvent: () => undefined },
    );
    if (controller.signal.aborted) message = `the probe exceeded ${options.timeoutMs ?? PROBE_TIMEOUT_MS}ms`;
    else if (outcome.status !== "completed")
      message = sanitizeFailureMessage(`${outcome.error?.code ?? "failed"}: ${outcome.error?.message ?? "the probe generation failed"}`);
    else if (outcome.text.toUpperCase().includes(code)) ok = true;
    else message = "the model did not quote the code the PDF holds: the endpoint may drop file parts, or the model may not read PDFs";
  } catch (error) {
    message = controller.signal.aborted
      ? `the probe exceeded ${options.timeoutMs ?? PROBE_TIMEOUT_MS}ms`
      : sanitizeFailureMessage(errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
  const after = ok ? await service.confirmPdfInput({ connectionId, expectedUpdatedAt: connection.updatedAt }) : connection;
  return {
    connectionId,
    modelId,
    ok,
    pdfInput: after.pdfInput ?? "none",
    latencyMs: Date.now() - started,
    ...(message === undefined ? {} : { message }),
  };
}

/** The model a probe asks: `--model`, else the connection's default; one of 1-256 characters, or a typed refusal naming `command`. */
function modelIdFor(connection: ModelConnection, model: string | undefined, command: string): string {
  const modelId = model ?? connection.defaultModel;
  if (modelId === undefined) throw new TaviError("INVALID_INPUT", `${command} needs --model or a connection default`);
  // Validated here so an over-long id is a typed refusal rather than a schema error surfacing as an internal failure.
  if (modelId.length > 256 || modelId.trim() === "")
    throw new TaviError("INVALID_INPUT", `${command} needs a model id of 1-256 characters`);
  return modelId;
}

/** What `tavi models video` answers: the connection's video models after the change, and the disclosure it was made under. */
export interface VideoModelsResult {
  readonly connectionId: string;
  readonly videoModels: readonly string[];
  readonly disclosure?: string;
}

/**
 * `tavi models video <connection> --enable <model> --yes` / `--disable <model>`:
 * native video on for one model only
 * once the owner confirmed the disclosure, which names the provider and the
 * model; refused unconfirmed, with the disclosure to read.
 */
export async function setVideoModelAndReport(
  service: ModelConfigService,
  connectionId: string,
  change: { readonly enable?: string; readonly disable?: string; readonly confirmed: boolean },
): Promise<VideoModelsResult> {
  const connection = await service.getConnection(connectionId);
  if ((change.enable === undefined) === (change.disable === undefined))
    throw new TaviError("INVALID_INPUT", "models video takes one of --enable <model> or --disable <model>");
  if (change.disable !== undefined) {
    const after = await service.setVideoModel({ connectionId, modelId: change.disable, enabled: false });
    return { connectionId, videoModels: after.videoModels ?? [] };
  }
  const model = change.enable as string;
  // The service says whether the model can have it at all before it asks for the disclosure, and asks with its text.
  const after = await service.setVideoModel({ connectionId, modelId: model, enabled: true, disclosureConfirmed: change.confirmed });
  return {
    connectionId,
    videoModels: after.videoModels ?? [],
    disclosure: videoDisclosure(presetOf(connection.baseUrl)?.name ?? connection.label, model),
  };
}

/** The video probe's clip: 4 s of 320 × 240 at 4 fps, a digit a second. */
export const VIDEO_PROBE_CLIP = { width: 320, height: 240, fps: 4, seconds: 4 } as const;

/** Each digit's seven segments, a to g. */
const SEGMENTS: Readonly<Record<string, string>> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

/**
 * The probe clip's frames, raw RGB: each digit of `code`, white seven-segment
 * blocks on black (no font), held for a second. What the model is asked to read
 * back, in order.
 */
export function probeClipFrames(code: string): Uint8Array[] {
  const { width, height, fps } = VIDEO_PROBE_CLIP;
  const frames: Uint8Array[] = [];
  for (const digit of code) {
    const frame = new Uint8Array(width * height * 3);
    const fill = (x0: number, y0: number, w: number, h: number): void => {
      for (let y = y0; y < y0 + h; y += 1)
        for (let x = x0; x < x0 + w; x += 1) frame.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    // A digit 100 wide and 180 tall, centred, strokes 20 thick.
    const left = 110;
    const top = 30;
    const segments: Readonly<Record<string, readonly [number, number, number, number]>> = {
      a: [left, top, 100, 20],
      g: [left, top + 80, 100, 20],
      d: [left, top + 160, 100, 20],
      f: [left, top, 20, 100],
      b: [left + 80, top, 20, 100],
      e: [left, top + 80, 20, 100],
      c: [left + 80, top + 80, 20, 100],
    };
    for (const segment of SEGMENTS[digit] ?? "") {
      const rect = segments[segment];
      if (rect !== undefined) fill(...rect);
    }
    for (let index = 0; index < fps; index += 1) frames.push(frame);
  }
  return frames;
}

/** Four random digits, none the same as the one before it. */
export function probeCode(): string {
  let code = String(randomInt(10));
  while (code.length < 4) {
    const next = String(randomInt(10));
    if (next !== code.at(-1)) code += next;
  }
  return code;
}

/**
 * Whether a reply reads the probe's digits back in order: its digits, a run of
 * the same one counted once (a model may name a digit for each frame it held),
 * hold the code.
 */
export function readsProbeCode(reply: string, code: string): boolean {
  return reply
    .replace(/\D/g, "")
    .replace(/(\d)\1+/g, "$1")
    .includes(code);
}

/** What `models probe --video` found: whether the model read the clip's digits back in order, and the row's token after it. */
export interface VideoProbeResult {
  readonly connectionId: string;
  readonly modelId: string;
  readonly ok: boolean;
  /** Whether the catalog row says `video-probed` now. */
  readonly videoProbed: boolean;
  readonly latencyMs: number;
  readonly message?: string;
}

/**
 * `tavi models probe <id> --video [--model <m>]`: the person's FFmpeg encodes a 4-second clip of four random
 * digits, which goes to the model whole, as `video.view` would send it. It
 * passes only when the reply holds the four digits in order: the model's row
 * then says `video-probed`, which a failing probe clears. A probe that never
 * reached an answer (stopped, timed out, a provider fault worth a retry)
 * changes nothing. Never for an endpoint that takes no video or a
 * provider-managed connection.
 */
export async function probeVideoAndRecord(
  service: ModelConfigService,
  connectionId: string,
  model: string | undefined,
  readSecret: CredentialResolver,
  options: {
    readonly decoder: Pick<VideoDecoderPort, "encodeClip">;
    readonly workDirectory: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
): Promise<VideoProbeResult> {
  const connection = await service.getConnection(connectionId);
  if (connection.providerBinding !== undefined)
    throw new TaviError(
      "CAPABILITY_MISSING",
      "Provider-managed connections take no video probe; models probe --video supports builtin connections",
    );
  if (presetVideoNever(connection.baseUrl))
    throw new TaviError("UNSUPPORTED", `Connection ${connectionId}'s endpoint takes no video: chats on it see a video's frames`);
  assertModelSpecification();
  const modelId = modelIdFor(connection, model, "models probe --video");
  // The credential first: a missing one is the owner's to fix, never a verdict on the model.
  const credential = await readSecret(connection.credentialRef);
  if (credential === null || credential.trim() === "")
    throw new TaviError("NOT_CONFIGURED", `Credential reference ${connection.credentialRef} is not configured; the probe sent nothing`);
  // No digit twice in a row: a held digit reads as one, whoever watches it.
  const code = probeCode();
  mkdirSync(options.workDirectory, { recursive: true, mode: 0o700 });
  const clipPath = join(options.workDirectory, `probe-${randomUUID()}.mp4`);
  const encoded = await options.decoder.encodeClip(probeClipFrames(code), VIDEO_PROBE_CLIP, clipPath);
  if (!encoded.ok)
    throw new TaviError(
      "UNAVAILABLE",
      `the probe clip could not be encoded: ${"refused" in encoded ? (encoded.detail ?? encoded.refused) : encoded.failure}`,
    );
  let clip: Uint8Array;
  try {
    clip = new Uint8Array(readFileSync(clipPath));
  } finally {
    rmSync(clipPath, { force: true });
  }
  const adapter = createAiSdkModelAdapter({
    // Sent as an enabled model would be sent it: the probe is what says whether it reads video.
    connections: [{ ...providerConnectionOf(connection), videoModels: [modelId] }],
    readSecret: async () => credential,
    resolveVideo: (artifactId) => (artifactId === "probe" ? { mediaType: "video/mp4", data: clip } : undefined),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const attempt = randomUUID();
  const at = nowTimestamp();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  let verdict: "pass" | "fail" | "unknown" = "unknown";
  let message: string | undefined;
  try {
    const outcome = await adapter.stream(
      {
        connectionId: connection.connectionId,
        model: modelId,
        runId: `models-probe-${attempt}`,
        attemptId: `models-probe-${attempt}`,
        attemptNumber: 1,
        messages: [
          {
            id: "ask",
            role: "user",
            text: "This connection is being checked for video input. Watch the video the tool returned: it shows four digits, one after another. Reply with the four digits in the order they appear, and nothing else.",
            createdAt: at,
          },
          { id: "call", role: "assistant", text: "", createdAt: at, toolCalls: [{ id: "probe-view", name: "video.view", input: {} }] },
          {
            id: "result",
            role: "tool",
            text: "",
            createdAt: at,
            toolResults: [
              {
                toolCallId: "probe-view",
                toolName: "video.view",
                isError: false,
                output: {
                  video: { durationSec: VIDEO_PROBE_CLIP.seconds },
                  [TOOL_VIDEO_KEY]: { artifactId: "probe", mediaType: "video/mp4" },
                },
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 512,
      },
      { signal: controller.signal, onEvent: () => undefined },
    );
    if (controller.signal.aborted) message = `the probe exceeded ${options.timeoutMs ?? PROBE_TIMEOUT_MS}ms`;
    else if (outcome.status !== "completed") {
      message = sanitizeFailureMessage(`${outcome.error?.code ?? "failed"}: ${outcome.error?.message ?? "the probe generation failed"}`);
      // An endpoint that refuses the request as malformed, or the model as retired, does not take video here;
      // anything else (authentication, quota, a model away, a connection that failed) says nothing about video.
      if (outcome.error?.code === "invalid_request" || outcome.error?.code === "model_retired") verdict = "fail";
    } else if (readsProbeCode(outcome.text, code)) verdict = "pass";
    else {
      verdict = "fail";
      message = "the model did not read the clip's four digits back in order: the endpoint may drop video, or the model may not watch it";
    }
  } catch (error) {
    message = controller.signal.aborted
      ? `the probe exceeded ${options.timeoutMs ?? PROBE_TIMEOUT_MS}ms`
      : sanitizeFailureMessage(errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
  // Recorded only for a definite answer, and only against the connection as it was probed, in one step.
  const recorded =
    verdict === "unknown"
      ? undefined
      : await service.recordVideoProbe({ connectionId, modelId, passed: verdict === "pass", expectedUpdatedAt: connection.updatedAt });
  if (verdict !== "unknown" && recorded === undefined)
    message = `the connection changed while it was probed, so nothing was recorded${message === undefined ? "" : `; ${message}`}`;
  const after = recorded ?? (await service.listCatalog(connectionId)).find((entry) => entry.modelId === modelId);
  return {
    connectionId,
    modelId,
    ok: verdict === "pass" && recorded !== undefined,
    videoProbed: after?.capabilities.includes(VIDEO_PROBED_CAPABILITY) === true,
    latencyMs: Date.now() - started,
    ...(message === undefined ? {} : { message }),
  };
}
