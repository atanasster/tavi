import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MAX_MOD_HOOKS,
  MOD_EVENTS,
  MOD_FAILURE_RULES,
  ModHookMatchSchema,
  ROUTER_PROVIDER_FAILURES,
  modFailureRuleOf,
  type PluginManifest,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxPort,
} from "@tavi/contracts";
import { errorMessage, plural } from "@tavi/contracts/util";
import type { Catalog } from "@tavi/contracts/i18n";
import {
  declarationFor,
  isLocalePackError,
  ownerStagingDirectory,
  validatePluginDirectory,
  type PluginFile,
  type PluginFileCheck,
} from "@tavi/runtime";

import { schemaFlags } from "../mcp/review.js";
import { probeReadPaths } from "./probe-paths.js";
import { withOwnerSandbox } from "../sandbox/host.js";
import { listed, pluginLocaleReport, pluginLocaleReportOnDisk, type PluginLocaleCoverage } from "./validate-locales.js";

/**
 * `tavi plugins validate <dir>`: what install
 * would refuse, without installing — and, on macOS and on Linux where the sandbox works, the plugin's `register`
 * run in the runtime sandbox (no network, no writes, an
 * empty environment), against a context that only records what it is handed.
 */
export interface PluginValidation {
  readonly pluginId?: string;
  readonly version?: string;
  readonly contentHash?: string;
  readonly files?: number;
  /** What install or the owner's load would refuse. */
  readonly problems: readonly string[];
  /** Its language packs (`locales`), each with its problems and what it translates; absent when it declares none. */
  readonly locales?: readonly PluginLocaleCoverage[];
  /** What loads, but may not be what the author meant. */
  readonly warnings: readonly string[];
  /** What `register` registered, when it ran. */
  readonly registered?: PluginRegistrations;
  /** Why `register` was not run, when it was not. */
  readonly skipped?: string;
}

const name = z.string().max(256);
const RegistrationsSchema = z.strictObject({
  // Whether each was handed a function the owner can call: a hook without one, or a command without `run`, fails its load.
  hooks: z.array(z.strictObject({ event: name, match: z.unknown().optional(), hook: z.boolean().optional() })).max(256),
  commands: z.array(name).max(256),
  commandsWithoutRun: z.array(name).max(256).optional(),
  // How many it registered in all: the lists stop at 256, so a count past the cap is still told.
  hookCount: z.number().int().min(0).optional(),
  commandCount: z.number().int().min(0).optional(),
  tools: z.array(name).max(256),
  // Each registered tool's input schema as JSON Schema, as the owner converts it; optional, as `heartbeat`.
  toolSchemas: z
    .array(z.strictObject({ name, schema: z.unknown() }))
    .max(256)
    .optional(),
  providers: z.array(z.strictObject({ kind: z.enum(["search", "fetch", "model"]), name })).max(256),
  channels: z.array(name).max(64),
  router: z.boolean(),
  // Optional, so an answer from a runner before heartbeat providers still reads.
  heartbeat: z.strictObject({ tick: z.boolean() }).optional(),
  signals: z.array(name).max(64).optional(),
  // The memory provider `provideMemory` supplied: which of its methods are functions. Optional, as `heartbeat`.
  memory: z.strictObject({ recall: z.boolean(), capture: z.boolean(), consolidate: z.boolean(), sync: z.boolean() }).optional(),
  // The ideas provider `provideIdeas` supplied: whether its generate is a function. Optional, as `heartbeat`.
  ideas: z.strictObject({ generate: z.boolean() }).optional(),
  // The onboarding flow `provideOnboarding` supplied: whether its flow is a function. Optional, as `heartbeat`.
  onboarding: z.strictObject({ flow: z.boolean() }).optional(),
});
type PluginRegistrations = z.infer<typeof RegistrationsSchema>;
const RunnerOutputSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), registered: RegistrationsSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(16_384) }),
]);

/** Starts the runner's own answer on stdout, after whatever the plugin printed; each run adds a nonce its plugin cannot know. */
const RESULT_MARKER = "<<tavi-validate-result>>";

/** The run's deadline; the runner is killed with its process group when it passes. */
const VALIDATE_TIMEOUT_MS = 10_000;
const VALIDATE_MAX_OUTPUT_BYTES = 1024 * 1024;
/** The tools' schemas the runner answers with, in all: past this, the rest are not reviewed. */
const SCHEMA_BYTES_KEPT = 256 * 1024;

export interface ValidateOptions {
  readonly builtins?: ReadonlySet<string>;
  /** A sandbox to run `register` in (`serve`'s engine); without one, an engine of its own, closed after. */
  readonly sandbox?: SandboxPort;
  readonly platform?: NodeJS.Platform;
  /** What its reader refuses of each file read (`plugins.validate`: what `fs.read` refuses in the chat's folders). */
  readonly checkFile?: PluginFileCheck;
}

export async function validatePlugin(directory: string, options: ValidateOptions = {}): Promise<PluginValidation> {
  let checked: { readonly manifest: PluginManifest; readonly hash: string; readonly files: readonly PluginFile[] };
  try {
    checked = validatePluginDirectory(directory, options.builtins, options.checkFile);
  } catch (error) {
    const message = errorMessage(error);
    // Install stops at a pack's first problem (once every file was read and the rest checked): every pack's are told, in place of that one.
    const packs = isLocalePackError(error) ? pluginLocaleReportOnDisk(directory, options.checkFile) : undefined;
    if (packs === undefined || packs.problems.length === 0) return { problems: [message], warnings: [] };
    return { problems: packs.problems, warnings: packs.warnings, locales: packs.locales };
  }
  const { manifest, hash, files } = checked;
  const packs = pluginLocaleReport(manifest, (path) => files.find((file) => file.relative === path)?.content);
  const head = {
    pluginId: manifest.id,
    version: manifest.version,
    contentHash: hash,
    files: files.length,
    ...(packs.locales.length === 0 ? {} : { locales: packs.locales }),
  };
  const warnings = [
    ...(manifest.mods?.hooks ?? []).flatMap((hook) =>
      MOD_FAILURE_RULES[hook.event].length > 1 && hook.onFailure === undefined
        ? [
            `its ${hook.event} hook states no onFailure, so it fails as ${modFailureRuleOf(hook)}; say so in the manifest (${MOD_FAILURE_RULES[hook.event].join(" or ")})`,
          ]
        : [],
    ),
    ...packs.warnings,
  ];
  // An MCP server runs no code in the owner; its code runs in its sandbox, at its probe.
  if (manifest.mcp !== undefined)
    return {
      ...head,
      problems: [],
      warnings,
      skipped: "an MCP server runs no owner code: its code runs in its sandbox, at `tavi mcp probe`",
    };
  if (manifest.entry === undefined)
    return { ...head, problems: [], warnings, skipped: "it has no entry: a ui-only plugin runs no owner code" };
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux")
    return {
      ...head,
      problems: [],
      warnings,
      skipped: `register runs in the sandbox on macOS and Linux; on ${platform} the manifest was checked`,
    };
  return await withOwnerSandbox(options.sandbox, async (sandbox) => {
    // Settled first: a host that cannot confine says so here, as a skip, not as a failed register.
    const capabilities = (await sandbox.ready?.()) ?? sandbox.capabilities();
    if (!capabilities.available)
      return { ...head, problems: [], warnings, skipped: `the sandbox is unavailable: ${capabilities.detail ?? "not supported here"}` };
    const outcome = await runRegister(manifest, files, sandbox, packs.english);
    if (!outcome.ok) return { ...head, problems: [`register failed: ${outcome.error}`], warnings };
    return { ...head, ...compare(manifest, outcome.registered, warnings), registered: outcome.registered };
  });
}

/** Each registration against the manifest, by the owner's own checks. */
function compare(
  manifest: PluginManifest,
  registered: PluginRegistrations,
  warnings: readonly string[],
): { readonly problems: readonly string[]; readonly warnings: readonly string[] } {
  const problems: string[] = [];
  const more = [...warnings];
  const declaredHooks = manifest.mods?.hooks ?? [];
  // As the owner refuses them: more hooks than a manifest may declare, a hook that is no function, a command with no `run`.
  const hookCount = registered.hookCount ?? registered.hooks.length;
  if (hookCount > MAX_MOD_HOOKS) problems.push(`hooks.on: register adds ${hookCount} hooks, more than ${MAX_MOD_HOOKS}`);
  for (const hook of registered.hooks) if (hook.hook === false) problems.push(`hooks.on("${hook.event}") needs a hook function`);
  for (const command of registered.commandsWithoutRun ?? []) problems.push(`commands.register("${command}") needs a run function`);
  for (const command of new Set(registered.commands.filter((name, index, names) => names.indexOf(name) !== index)))
    problems.push(`commands.register("${command}"): registered twice`);
  for (const hook of registered.hooks) {
    if (!(MOD_EVENTS as readonly string[]).includes(hook.event)) {
      problems.push(`hooks.on("${hook.event}"): there is no such event`);
      continue;
    }
    const match = hook.match === undefined ? undefined : ModHookMatchSchema.safeParse(hook.match);
    if (match !== undefined && !match.success) {
      problems.push(`hooks.on("${hook.event}"): its match is not one Tavi reads`);
      continue;
    }
    try {
      declarationFor(manifest.id, declaredHooks, hook.event as (typeof MOD_EVENTS)[number], match?.data);
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  for (const hook of declaredHooks) {
    if (!registered.hooks.some((candidate) => candidate.event === hook.event))
      more.push(`it declares a ${hook.event} hook that register does not add`);
  }
  const declaredCommands = manifest.mods?.commands ?? [];
  for (const command of registered.commands) {
    if (!declaredCommands.some((declared) => declared.name === command))
      problems.push(`commands.register("${command}"): not declared in the manifest's mods block`);
  }
  for (const command of declaredCommands) {
    if (!registered.commands.includes(command.name)) more.push(`it declares a /${command.name} command that register does not add`);
  }
  for (const tool of registered.tools) {
    if (!manifest.tools.some((declared) => declared.name === tool))
      problems.push(`registerTool("${tool}"): not declared in the manifest's tools`);
  }
  for (const tool of manifest.tools) {
    if (!registered.tools.includes(tool.name)) more.push(`it declares a tool ${tool.name} that register does not add`);
  }
  // The model reads a tool's schema: prose in it that reads like instructions is what `tavi mcp` flags in a server's.
  for (const tool of registered.toolSchemas ?? []) {
    const flagged = schemaFlags(tool.schema, "");
    if (flagged.length > 0)
      more.push(
        `registerTool("${tool.name}"): its schema reads like instructions to the model at ${flagged.slice(0, 5).join(", ")}${flagged.length > 5 ? ", …" : ""}`,
      );
  }
  for (const provider of registered.providers) {
    if (!manifest.capabilities.some((capability) => capability.kind === provider.kind && capability.id === provider.name))
      problems.push(
        `register${provider.kind[0]?.toUpperCase() ?? ""}${provider.kind.slice(1)}("${provider.name}"): not a ${provider.kind} capability of the manifest`,
      );
  }
  for (const channel of registered.channels) {
    if (!manifest.channels.some((declared) => declared.providerId === channel))
      problems.push(`registerChannel("${channel}"): not one of the manifest's channels`);
  }
  if (registered.router && manifest.router === undefined) problems.push("provideRouter: the manifest declares no router");
  if (registered.heartbeat !== undefined && manifest.heartbeat === undefined)
    problems.push("provideHeartbeat: the manifest declares no heartbeat provider");
  if (registered.heartbeat?.tick === false) problems.push("provideHeartbeat needs a tick function");
  if (manifest.heartbeat !== undefined && registered.heartbeat === undefined)
    more.push("it declares a heartbeat provider that register does not supply");
  const declaredSources = manifest.heartbeatSignals?.sources ?? [];
  for (const source of registered.signals ?? []) {
    if (!declaredSources.includes(source)) problems.push(`provideSignals("${source}"): not one of the manifest's heartbeat signal sources`);
  }
  for (const source of new Set((registered.signals ?? []).filter((id, index, ids) => ids.indexOf(id) !== index)))
    problems.push(`provideSignals("${source}"): supplied twice`);
  for (const source of declaredSources) {
    if (!(registered.signals ?? []).includes(source))
      more.push(`it declares a heartbeat signal source ${source} that register does not supply`);
  }
  if (registered.memory !== undefined && manifest.memory === undefined)
    problems.push("provideMemory: the manifest declares no memory provider");
  if (registered.memory?.recall === false) problems.push("provideMemory needs a recall function");
  if (registered.memory !== undefined && manifest.memory !== undefined) {
    for (const capability of ["capture", "consolidate"] as const) {
      if (registered.memory[capability] && !manifest.memory.capabilities.includes(capability))
        problems.push(`provideMemory: ${capability} is not a capability the manifest lists`);
      if (!registered.memory[capability] && manifest.memory.capabilities.includes(capability))
        more.push(`it lists the ${capability} capability but its provider has no ${capability} function`);
    }
    if (registered.memory.sync && manifest.memory.index !== "own")
      problems.push('provideMemory: sync keeps an index of its own, and the manifest says index "host"');
    if (!registered.memory.sync && manifest.memory.index === "own")
      problems.push('provideMemory: index "own" needs a sync function, or its index never learns a removal');
  }
  if (manifest.memory !== undefined && registered.memory === undefined)
    more.push("it declares a memory provider that register does not supply");
  if (registered.ideas !== undefined && manifest.ideas === undefined)
    problems.push("provideIdeas: the manifest declares no ideas provider");
  if (registered.ideas?.generate === false) problems.push("provideIdeas needs a generate function");
  if (manifest.ideas !== undefined && registered.ideas === undefined)
    more.push("it declares an ideas provider that register does not supply");
  if (registered.onboarding !== undefined && manifest.onboarding === undefined)
    problems.push("provideOnboarding: the manifest declares no onboarding flow");
  if (registered.onboarding?.flow === false) problems.push("provideOnboarding needs a flow function");
  if (manifest.onboarding !== undefined && registered.onboarding === undefined)
    more.push("it declares an onboarding flow that register does not supply");
  return { problems, warnings: more };
}

/**
 * The runner: imports the plugin's entry and calls `register` with a context
 * that records each registration and does nothing else. Zod is bundled in, so
 * `ctx.z` describes input as it does in the owner.
 */
function runnerSource(entry: string, marker: string, english: Catalog): string {
  return `
import { z } from "zod";
import { pluginTranslate } from "@tavi/contracts/i18n";

// After a marker line, last: the plugin's own code may write to stdout too.
const finish = (payload, code) => process.stdout.write(${JSON.stringify(`\n${marker}`)} + JSON.stringify(payload), () => process.exit(code));
class TaviError extends Error { constructor(code, message) { super(message); this.code = code; } }
class RouterProviderError extends Error { constructor(reason, usage) { super(reason); this.reason = reason; this.usage = usage; } }
class HeartbeatProviderError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class MemoryProviderError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class IdeasProviderError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const registered = { hooks: [], commands: [], commandsWithoutRun: [], hookCount: 0, commandCount: 0, tools: [], toolSchemas: [], providers: [], channels: [], router: false, signals: [] };
// The lists stop at what the answer's schema holds; the counts go on.
const keep = (list, value) => { if (list.length < 256) list.push(value); };
const text = (value) => String(value).slice(0, 256);
// Each tool's input schema as the owner converts it, so its prose is reviewed; at most ${SCHEMA_BYTES_KEPT} bytes of them in all.
let schemaBytes = 0;
const keepSchema = (tool) => {
  try {
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input", target: "draft-7", unrepresentable: "any" });
    const size = JSON.stringify(schema).length;
    if (schemaBytes + size > ${SCHEMA_BYTES_KEPT}) return;
    schemaBytes += size;
    keep(registered.toolSchemas, { name: text(tool?.name), schema });
  } catch {}
};
const controller = new AbortController();
const ctx = {
  pluginId: "validate", version: "0.0.0", config: Object.freeze({}), z,
  // English, with the plugin's English messages: a register that says something with ctx.t runs as it does in the owner.
  locale: "en",
  t: (key, params) => pluginTranslate({ en: ${JSON.stringify(english)} }, "en", key, params),
  log: { info() {}, warn() {}, error() {} },
  scope: { defer() {}, signal: controller.signal },
  signal: controller.signal,
  secret: async () => null,
  state: { load: async () => ({}), put: async () => {} },
  registerTool: (tool) => { registered.tools.push(text(tool?.name)); keepSchema(tool); },
  registerSearch: (name) => { registered.providers.push({ kind: "search", name: text(name) }); },
  registerFetch: (name) => { registered.providers.push({ kind: "fetch", name: text(name) }); },
  registerModel: (name) => { registered.providers.push({ kind: "model", name: text(name) }); },
  registerChannel: (definition) => { registered.channels.push(text(definition?.providerId)); },
  hooks: { on: (event, matchOrHook, maybeHook) => {
    const match = typeof matchOrHook === "function" ? undefined : JSON.parse(JSON.stringify(matchOrHook ?? null) ?? "null");
    const hook = typeof matchOrHook === "function" ? matchOrHook : maybeHook;
    registered.hookCount += 1;
    keep(registered.hooks, { event: text(event), ...(match === null || match === undefined ? {} : { match }), hook: typeof hook === "function" });
  } },
  commands: { register: (command) => {
    registered.commandCount += 1;
    keep(registered.commands, text(command?.name));
    if (typeof command?.run !== "function") keep(registered.commandsWithoutRun, text(command?.name));
  } },
  ui: { status() {}, notice() {}, publish() {} },
  provideRouter: () => { registered.router = true; },
  provideHeartbeat: (provider) => { registered.heartbeat = { tick: typeof provider?.tick === "function" }; },
  provideSignals: (source) => { keep(registered.signals, text(source?.id)); },
  provideIdeas: (provider) => { registered.ideas = { generate: typeof provider?.generate === "function" }; },
  provideOnboarding: (provider) => { registered.onboarding = { flow: typeof provider?.flow === "function" }; },
  provideMemory: (provider) => { registered.memory = { recall: typeof provider?.recall === "function", capture: typeof provider?.capture === "function", consolidate: typeof provider?.consolidate === "function", sync: typeof provider?.sync === "function" }; },
  RouterProviderError, HeartbeatProviderError, MemoryProviderError, IdeasProviderError, TaviError,
  ROUTER_PROVIDER_FAILURES: ${JSON.stringify(ROUTER_PROVIDER_FAILURES)},
};

try {
  const module = await import(${JSON.stringify(`./plugin/${entry}`)});
  // As the owner reads it: a default export object, else the module's own exports.
  const candidate = typeof module.default === "object" && module.default !== null ? module.default : module;
  if (typeof candidate.register !== "function" && typeof candidate.start !== "function") throw new Error("the entry exports neither register nor start");
  if (typeof candidate.register === "function") await candidate.register(ctx);
  finish({ ok: true, registered }, 0);
} catch (error) {
  finish({ ok: false, error: String(error?.stack || error?.message || error).slice(0, 16000) }, 1);
}
`;
}

async function runRegister(
  manifest: PluginManifest,
  files: readonly PluginFile[],
  sandbox: SandboxPort,
  english: Catalog,
): Promise<{ readonly ok: true; readonly registered: PluginRegistrations } | { readonly ok: false; readonly error: string }> {
  // Its real path: Node's permission model compares the resolved one, and the temporary directory is a link on macOS.
  const staging = realpathSync(mkdtempSync(join(ownerStagingDirectory(), "tavi-validate-")));
  try {
    for (const file of files) {
      const path = join(staging, "plugin", ...file.relative.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    const source = join(staging, "runner-src.mjs");
    // A plugin that prints an answer of its own does not know this run's marker. (It could find it by reading the runner:
    // validate is a check for the plugin's author, never a boundary against a plugin that means to deceive it.)
    const marker = `${RESULT_MARKER}${randomUUID()}>>`;
    writeFileSync(source, runnerSource(manifest.entry ?? "", marker, english));
    // The bundler is loaded only when a plugin is validated.
    const { rolldown } = await import("rolldown");
    const bundle = await rolldown({
      input: source,
      platform: "node",
      // `ctx.t` is the owner's own lookup, bundled in as the confined worker bundles it.
      resolve: {
        alias: {
          zod: fileURLToPath(import.meta.resolve("zod")),
          "@tavi/contracts/i18n": fileURLToPath(import.meta.resolve("@tavi/contracts/i18n")),
        },
      },
      external: (id) => id.startsWith("node:") || isBuiltin(id) || id.startsWith("./plugin/"),
    });
    try {
      await bundle.write({ file: join(staging, "runner.mjs"), format: "esm", sourcemap: false });
    } finally {
      await bundle.close();
    }
    // No network, no writes, reads only the staged copy and what Node needs, and an empty environment.
    const policy: SandboxPolicy = {
      network: { allow: false, allowedHosts: [] },
      filesystem: { denyPaths: ["/"], allowRead: probeReadPaths(staging), allowWrite: [] },
      resources: { timeoutMs: VALIDATE_TIMEOUT_MS, maxOutputBytes: VALIDATE_MAX_OUTPUT_BYTES },
    };
    const command: SandboxCommand = {
      command: process.execPath,
      args: ["--permission", `--allow-fs-read=${staging}`, "runner.mjs"],
      cwd: staging,
      env: {},
      inheritEnv: false,
    };
    let run;
    try {
      run = await sandbox.run(policy, command);
    } catch (error) {
      return { ok: false, error: `the sandbox could not run it: ${errorMessage(error)}` };
    }
    if (run.session.state === "cancelled") return { ok: false, error: `it did not finish within ${VALIDATE_TIMEOUT_MS / 1000} s` };
    if (run.truncated) return { ok: false, error: `it wrote more than ${VALIDATE_MAX_OUTPUT_BYTES} bytes` };
    let raw: unknown;
    const at = run.stdout.lastIndexOf(marker);
    try {
      if (at < 0) throw new Error("no answer");
      raw = JSON.parse(run.stdout.slice(at + marker.length));
    } catch {
      return { ok: false, error: `it exited with code ${String(run.exitCode)}: ${(run.stderr || "no output").slice(0, 4_096)}` };
    }
    const parsed = RunnerOutputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "it answered in a shape the validate runner never writes" };
    return parsed.data;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The report as `tavi plugins validate` prints it. */
export function renderPluginValidation(directory: string, report: PluginValidation): string {
  const lines = [
    report.pluginId === undefined
      ? directory
      : `${report.pluginId} ${report.version ?? ""} (${String(report.files)} files, sha256 ${report.contentHash?.slice(0, 12) ?? ""}…)`,
  ];
  if (report.registered !== undefined) {
    const { hooks, commands, tools, providers, channels, router, heartbeat, signals = [], memory } = report.registered;
    const heartbeats = `${heartbeat === undefined ? "" : ", a heartbeat provider"}${signals.length === 0 ? "" : `, ${plural(signals.length, "heartbeat signal source")} (${signals.join(", ")})`}${memory === undefined ? "" : `, a memory provider (${(["recall", "capture", "consolidate", "sync"] as const).filter((method) => memory[method]).join(", ")})`}`;
    lines.push(
      `register ran in the sandbox: ${plural(hooks.length, "hook")}${hooks.length === 0 ? "" : ` (${hooks.map((hook) => hook.event).join(", ")})`}, ${plural(commands.length, "command")}, ${plural(tools.length, "tool")}, ${plural(providers.length, "provider")}, ${plural(channels.length, "channel")}${router ? ", a router" : ""}${heartbeats}`,
    );
  }
  if (report.skipped !== undefined) lines.push(`register not run: ${report.skipped}`);
  for (const pack of report.locales ?? []) lines.push(...packLines(pack));
  for (const problem of report.problems) lines.push(`error: ${problem}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  lines.push(report.problems.length === 0 ? "valid" : "not valid");
  return `${lines.join("\n")}\n`;
}

/** A language pack's lines: what it translates of the total, and what it leaves to English. */
function packLines(pack: PluginLocaleCoverage): string[] {
  const head = `language pack ${pack.locale} (${pack.path})`;
  if (pack.manifest === undefined && pack.messages === undefined) return [`${head}: not valid, its errors below`];
  // A count with nothing to count (no messages in any pack, a manifest with no words a pack takes) is left out.
  const counts = [
    ...(pack.manifest === undefined || pack.manifest.total === 0
      ? []
      : [`${String(pack.manifest.translated)} of ${plural(pack.manifest.total, "manifest field")}`]),
    ...(pack.messages === undefined || pack.messages.total === 0
      ? []
      : [`${String(pack.messages.translated)} of ${plural(pack.messages.total, "message")}`]),
  ];
  const lines = [`${head}: ${counts.length === 0 ? "nothing to translate" : counts.join(", ")}`];
  if (pack.manifest !== undefined && pack.manifest.missing.length > 0)
    lines.push(`  fields left in English: ${listed(pack.manifest.missing)}`);
  if (pack.messages !== undefined && pack.messages.missing.length > 0)
    lines.push(`  messages ${pack.locale === "en" ? "without English" : "left to English"}: ${listed(pack.messages.missing)}`);
  return lines;
}
