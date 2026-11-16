import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The template data directory a live eval copies for every run, so a run
 * never writes into a data directory in use: what a template may hold, the
 * check that holds it to that, and the private copy each run gets. Shared by
 * `evals/memory/eval.ts`, `evals/memory/cache-gate.ts`,
 * `evals/heartbeat/eval.ts` and `evals/browser/eval.ts`; tested in
 * `tests/eval-template.test.ts`.
 *
 * Erasable TypeScript only, so `node` runs it with no build.
 */

/**
 * A copy of a data directory for one run: Tavi
 * refuses a data directory others can read (`NOT_AUTHORIZED`, "expected a
 * private directory"), so the copy and every directory in it is `0700`,
 * whatever the copy's umask made it.
 */
export function privateCopy(from: string, to: string): string {
  cpSync(from, to, { recursive: true });
  const tighten = (path: string): void => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) tighten(join(path, entry.name));
  };
  tighten(to);
  return to;
}

/** Whether a directory's mode lets only its owner in (for the tests). Windows has no mode bits: its folder is private by its ACL, which Node cannot read. */
export const isPrivateDirectory = (path: string): boolean => process.platform === "win32" || (statSync(path).mode & 0o077) === 0;

/**
 * What a template data directory may hold — an allowlist: model connections,
 * the model catalog (and its prices), role bindings and workspace defaults,
 * credentials, the ledger of the calls a connection test made, and what a
 * fresh directory holds once served (its schema, an empty memory index and
 * the seeded default tool rules). Anything else would ride every copy into an
 * owner (a reminder, a schedule, a routine, a heartbeat, a plugin or a
 * messaging connection acting from the copy) or into the measurement (chats,
 * records, rules, agents or settings the eval did not make).
 */
const TEMPLATE_TABLES = new Set([
  // A fresh directory's own rows.
  "sqlite_sequence",
  "tavi_meta",
  "tavi_schema_migrations",
  "tavi_memory_fts_config",
  "tavi_memory_fts_data",
  "tavi_memory_fts_stem_config",
  "tavi_memory_fts_stem_data",
  // Model connections, the catalog, role bindings and the workspace default target.
  "tavi_model_connections",
  "tavi_model_catalog",
  "tavi_model_price_sheets",
  "tavi_model_roles",
  "tavi_model_workspace_defaults",
  // The calls `tavi models test` made: the ledger each copy's spend is measured from.
  "tavi_provider_attempts",
  "tavi_provider_attempt_requests",
  "tavi_provider_operations",
  // Which default rules were seeded; the rules themselves and the settings are read row by row below.
  "tavi_tool_rule_seeds",
  "tavi_tool_rules",
  "tavi_workspace_settings",
]);

/** The workspace settings a template may set (its workspace defaults); any other (`memory`, plugin UI roles, a linked DM) is refused. */
const TEMPLATE_SETTINGS = new Set([
  "timezone",
  "activitySummaries",
  "activitySummaryModel",
  "browserNoThumbnailHosts",
  "homeChat",
  "keptModelRequests",
  "promptLayout",
  "travelFlightSearch",
  "travelGoogleFlights",
  "redactToolResults",
  "securityTaint",
]);

export type TaintMode = "off" | "observe" | "enforce";

/**
 * The effective taint mode for a workspace: an owner's policy override when
 * set, else the workspace's `securityTaint` setting, else `"enforce"`.
 */
export function taintModeOf(settings: { readonly securityTaint?: TaintMode }, ownerPolicy?: TaintMode): TaintMode {
  return ownerPolicy ?? settings.securityTaint ?? "enforce";
}

/** Reads the effective taint mode from `dataDir`'s workspace settings table, defaulting to `"enforce"`. */
export async function templateTaintMode(dataDir: string, ownerPolicy?: TaintMode): Promise<TaintMode> {
  if (ownerPolicy !== undefined) return ownerPolicy;
  const path = join(dataDir, "tavi.sqlite");
  if (!existsSync(path)) return "enforce";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tavi_workspace_settings'").all() as {
      name: string;
    }[];
    if (tables.length === 0) return "enforce";
    const row = db.prepare("SELECT settings_json FROM tavi_workspace_settings WHERE workspace_id = 'default' LIMIT 1").get() as
      | { settings_json?: string }
      | undefined;
    if (typeof row?.settings_json !== "string") return "enforce";
    let parsed: { readonly securityTaint?: unknown };
    try {
      parsed = JSON.parse(row.settings_json) as { readonly securityTaint?: unknown };
    } catch {
      return "enforce";
    }
    const mode =
      parsed.securityTaint === "off" || parsed.securityTaint === "observe" || parsed.securityTaint === "enforce"
        ? parsed.securityTaint
        : undefined;
    return taintModeOf(mode === undefined ? {} : { securityTaint: mode }, ownerPolicy);
  } finally {
    db.close();
  }
}

/** What the data directory's own files may be: the database, the owner's lock and runtime files, credentials, logs and caches. */
const TEMPLATE_ENTRIES = new Set([
  "tavi.sqlite",
  "tavi.sqlite-wal",
  "tavi.sqlite-shm",
  "tavi.sqlite-journal",
  "owner.lock",
  "owner.lock-journal",
  "owner.process.json",
  "provider-bindings.key",
  "credentials",
  "credentials.key",
  "logs",
  "runtime",
  "cache",
  "ui",
]);

/** How a refused table or file is named in the refusal; one not named here is named by itself. */
const TEMPLATE_NAMES: Readonly<Record<string, string>> = {
  tavi_tasks: "chats",
  tavi_messaging_connections: "messaging connections",
  tavi_schedules: "schedules",
  tavi_reminders: "reminders",
  tavi_routines: "routines",
  tavi_heartbeats: "heartbeats",
  tavi_memory_records: "memory records",
  tavi_agent_definitions: "agent definitions",
  tavi_projects: "projects",
  tavi_plugin_versions: "installed plugin versions",
  tavi_plugin_settings: "plugin settings",
  tavi_plugin_state: "plugin state",
  tavi_workspace_system_prompts: "workspace system prompts",
  plugins: "installed plugins (plugins/)",
  chats: "chat folders (chats/)",
  artifacts: "artifacts (artifacts/)",
  "browser-profiles": "browser profiles (browser-profiles/)",
  "projects.json": "collector projects (projects.json)",
  "web-providers.json": "web search providers (web-providers.json)",
};

/**
 * What a data directory (a copy, nothing serving it) holds that `TEMPLATE_TABLES`,
 * `TEMPLATE_SETTINGS` and `TEMPLATE_ENTRIES` do not allow, each with how many:
 * rows of any other table, tool rules beyond the seeded ones, a refused
 * settings section, and any other file or non-empty folder.
 */
export async function templateHoldings(dataDir: string): Promise<Record<string, number>> {
  const holdings: Record<string, number> = {};
  const add = (what: string, count: number): void => {
    if (count > 0) holdings[what] = (holdings[what] ?? 0) + count;
  };
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (TEMPLATE_ENTRIES.has(entry.name)) continue;
    const count = entry.isDirectory() ? readdirSync(join(dataDir, entry.name)).length : 1;
    add(TEMPLATE_NAMES[entry.name] ?? entry.name, count);
  }
  const path = join(dataDir, "tavi.sqlite");
  if (!existsSync(path)) return holdings;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    for (const table of tables) {
      // An FTS5 table's own name holds no rows of its own; its shadow tables are listed beside it.
      if (TEMPLATE_TABLES.has(table) || table === "tavi_memory_fts" || table === "tavi_memory_fts_stem") continue;
      // `tavi models add` on a fresh directory writes onboarding's one row, blank: only progress in it is refused.
      if (table === "tavi_onboarding") {
        add(
          "onboarding progress",
          Number(
            (
              db
                .prepare(
                  "SELECT count(*) AS n FROM tavi_onboarding WHERE coalesce(provider_id, first_seen_at, completed_at, dismissed_at, dismissed_flow_version, flow_version) IS NOT NULL",
                )
                .get() as Record<string, number>
            )["n"],
          ),
        );
        continue;
      }
      add(
        TEMPLATE_NAMES[table] ?? `rows of ${table}`,
        Number((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as Record<string, number>)["n"]),
      );
    }
    if (tables.includes("tavi_tool_rules")) {
      const seeded = tables.includes("tavi_tool_rule_seeds")
        ? "EXISTS (SELECT 1 FROM tavi_tool_rule_seeds AS seed WHERE seed.workspace_id = rule.workspace_id AND seed.rule_id = rule.rule_id) AND json_extract(rule.rule_json, '$.createdBy') = 'tavi'"
        : "0";
      add(
        "tool rules beyond the seeded ones",
        Number(
          (db.prepare(`SELECT count(*) AS n FROM tavi_tool_rules AS rule WHERE NOT (${seeded})`).get() as Record<string, number>)["n"],
        ),
      );
    }
    if (tables.includes("tavi_workspace_settings")) {
      for (const row of db.prepare("SELECT settings_json FROM tavi_workspace_settings").all() as { settings_json: string }[]) {
        for (const key of Object.keys(JSON.parse(row.settings_json) as Record<string, unknown>))
          if (!TEMPLATE_SETTINGS.has(key)) add(`\`${key}\` settings`, 1);
      }
    }
  } finally {
    db.close();
  }
  return holdings;
}

/** Why a template is refused: it holds more than `templateHoldings` allows. */
export function templateRefusal(holdings: Readonly<Record<string, number>>): string | undefined {
  const held = Object.entries(holdings)
    .filter(([, count]) => count > 0)
    .map(([what, count]) => `${count} ${what}`);
  if (held.length === 0) return undefined;
  return `the template data directory holds ${held.join(", ")}: make a dedicated one that holds only model connections, their credentials and workspace defaults (see the eval's README), never a data directory in use`;
}

/** Refuses a template that holds more than `templateHoldings` allows, read from a private copy under `scratch` that is removed again. */
export async function checkTemplate(template: string, scratch: string): Promise<void> {
  const copy = privateCopy(template, join(scratch, "template-check"));
  let refusal: string | undefined;
  try {
    refusal = templateRefusal(await templateHoldings(copy));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  if (refusal !== undefined) throw new Error(refusal);
}

/** What `cleanupOnSignal` listens on and exits through (the process, or a test's stand-ins). */
export interface SignalHost {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * SIGINT and SIGTERM handlers for a live run: they stop the `tavi` commands
 * and owners it is given that are still running and remove the scratch folders (whose copies hold
 * credentials; kept with `keep`, as `--keep` keeps them), then exit 130 or 143,
 * as a shell reports the signal. A second signal while that runs is ignored.
 * Returns the handlers' removal, for a run that ends on its own.
 */
export function cleanupOnSignal(input: {
  readonly scratch: readonly string[];
  readonly keep?: boolean;
  readonly log?: (message: string) => void;
  readonly owners?: Iterable<{ stop(): Promise<unknown> }>;
  readonly commands?: Iterable<{ kill(signal: NodeJS.Signals): unknown }>;
  readonly host?: SignalHost;
}): () => void {
  const host: SignalHost = input.host ?? {
    on: (signal, listener) => process.on(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
    exit: (code) => process.exit(code),
  };
  const log = input.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  let cleaning = false;
  const handler = (signal: NodeJS.Signals) => (): void => {
    if (cleaning) return;
    cleaning = true;
    log(`${signal}: stopping the commands and owners still running and removing the scratch copies`);
    for (const command of input.commands ?? []) command.kill("SIGTERM");
    void Promise.allSettled([...(input.owners ?? [])].map((owner) => owner.stop())).then(() => {
      for (const dir of input.scratch) {
        if (input.keep === true) log(`data directories kept in ${dir}`);
        else rmSync(dir, { recursive: true, force: true });
      }
      host.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const onInt = handler("SIGINT");
  const onTerm = handler("SIGTERM");
  host.on("SIGINT", onInt);
  host.on("SIGTERM", onTerm);
  return () => {
    host.off("SIGINT", onInt);
    host.off("SIGTERM", onTerm);
  };
}

/** Why `template` cannot be copied: it is missing, or a running `tavi serve` has it open. */
export function templateUnusable(template: string): string | undefined {
  if (!existsSync(template)) return `no template data directory at ${template}`;
  if (existsSync(join(template, "runtime", "ipc.json")))
    return "`tavi serve` owns the template data directory: stop it, the eval copies the directory while nothing has it open";
  return undefined;
}

/** Where a live eval's runs keep their data: a fresh private copy of `template`, or, opted into, one existing directory they all write into. */
export type RunnerData = { readonly template: string } | { readonly dataDir: string };

/** A live eval's `--template` or `--data-dir`, exactly one: with neither it refuses, so it never runs in the default data directory. */
export function runnerData(template: string | undefined, dataDir: string | undefined, readme: string): RunnerData {
  if (template !== undefined && dataDir !== undefined) throw new Error("pass --template or --data-dir, not both");
  if (template !== undefined) return { template: resolve(template) };
  if (dataDir !== undefined) return { dataDir: resolve(dataDir) };
  throw new Error(
    `each run copies a template data directory: pass --template <dir> (see ${readme}), or --data-dir <dir> to write every run's task into that directory instead; the eval never runs in the default data directory`,
  );
}

/**
 * Runs `body` with `copy`, which makes a private copy of `template` under a
 * fresh `0700` scratch folder, after refusing a template that is missing,
 * served or holds more than `templateHoldings` allows. The scratch folder and
 * every copy in it are removed when `body` settles, and on SIGINT or SIGTERM
 * (which also stop `commands`). Short copy names: a unix socket under a data
 * directory has a short path limit.
 */
export async function withTemplateCopies<T>(
  template: string,
  input: {
    readonly prefix: string;
    readonly commands?: Iterable<{ kill(signal: NodeJS.Signals): unknown }>;
    readonly log?: (message: string) => void;
  },
  body: (copy: (name: string) => string) => Promise<T>,
): Promise<T> {
  const unusable = templateUnusable(template);
  if (unusable !== undefined) throw new Error(unusable);
  const scratch = mkdtempSync(join(tmpdir(), input.prefix));
  chmodSync(scratch, 0o700);
  // Interrupted, the run still stops its commands and removes its copies (they hold credentials).
  const removeSignalCleanup = cleanupOnSignal({
    scratch: [scratch],
    ...(input.commands === undefined ? {} : { commands: input.commands }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
  try {
    await checkTemplate(template, scratch);
    return await body((name) => privateCopy(template, join(scratch, name)));
  } finally {
    removeSignalCleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One `tavi run --format json --approval deny` of `prompt` in `dataDir`, to its
 * end: its NDJSON stream, and whether it was stopped at `timeoutMs`. The child
 * is in `running` while it runs, so an interrupt stops it. Its stderr goes to
 * this process's. For a live eval's runner; each eval reads the stream its own
 * way.
 */
export function taviRunJson(input: {
  readonly repositoryRoot: string;
  readonly prompt: string;
  readonly dataDir: string;
  readonly connectionId?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly running: Set<ChildProcess>;
}): Promise<{ readonly stdout: string; readonly timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(input.repositoryRoot, "scripts", "tavi.mjs"),
        "run",
        "--format",
        "json",
        "--approval",
        "deny",
        "--data-dir",
        input.dataDir,
        ...(input.connectionId === undefined ? [] : ["--connection", input.connectionId]),
        ...(input.model === undefined ? [] : ["--model", input.model]),
        input.prompt,
      ],
      { cwd: input.repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    input.running.add(child);
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.on("error", reject);
    child.on("close", () => {
      input.running.delete(child);
      clearTimeout(timer);
      resolvePromise({ stdout, timedOut });
    });
  });
}
