import { dirname, isAbsolute, join, sep } from "node:path";

import { MODEL_PROVIDER_PRESETS, ONBOARDING_ENV_KEYS, type OnboardingConnectAnswer, type OnboardingStatus } from "@tavi/contracts";
import { errorMessage, isRecord } from "@tavi/contracts/util";
import { parse as parseYaml } from "yaml";

import { addChannel, channelCatalog, channelSecretFields } from "./steps.js";
import type { OnboardTransport } from "./transport.js";
import { GLYPHS } from "../../tui/theme.js";

/**
 * Importing another agent's setup:
 * an OpenClaw (`~/.openclaw`) or Hermes (`~/.hermes`) install's model
 * connections and its Telegram bot, read from the files each documents — the
 * config and its `.env` — never from another tool's token store or a running
 * gateway. What is found is described by name and place alone; values stay in
 * a separate map that is used only when the person agrees to copy them. Every
 * write is Tavi's own `onboarding connect-key` (the connection first, then its
 * key) and Telegram's add-and-test, so a dry run and the real one say the same.
 */

export type ImportSource = "openclaw" | "hermes";
const IMPORT_SOURCES: readonly ImportSource[] = ["openclaw", "hermes"];
const SOURCE_NAMES: Readonly<Record<ImportSource, string>> = { openclaw: "OpenClaw", hermes: "Hermes" };

/** One model connection another agent has: its key by where it lives, never its value. */
interface ImportedConnection {
  /** The other agent's own name for it. */
  readonly name: string;
  /** The Tavi preset it becomes (`custom` with `baseUrl` for an endpoint of its own). */
  readonly preset: string;
  readonly baseUrl?: string;
  /** Its model, when the other agent names one. */
  readonly model?: string;
  /** The other agent's default model runs on it. */
  readonly isDefault: boolean;
  /** Where its key is (`OPENROUTER_API_KEY in ~/.openclaw/.env`); absent for a server that needs none. */
  readonly keyFrom?: string;
  /** The server needs no key (a local one, or OpenClaw's `auth: "none"`): imported without asking. */
  readonly keyless?: boolean;
  /** Why it cannot be imported, when it cannot. */
  readonly problem?: string;
}

export interface ImportFinding {
  readonly source: ImportSource;
  readonly root: string;
  readonly connections: readonly ImportedConnection[];
  /** Where its Telegram bot token is, when it has one. */
  readonly telegramFrom?: string;
}

/** A finding and the values it names, kept apart: the finding is printed, the values only ever sent to Tavi's own store. */
export interface FoundImport {
  readonly finding: ImportFinding;
  /** By connection name, and `telegram`. */
  readonly secrets: ReadonlyMap<string, string>;
}

export interface ImportFiles {
  readonly home: string;
  /** Where the other agents keep their homes when moved (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `HERMES_HOME`); nothing else is read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readText: (path: string) => Promise<string | undefined>;
}

// ------------------------------------------------------------------ parsing

/**
 * JSON5, as OpenClaw writes its config: comments, unquoted keys, single
 * quotes, trailing commas, hex and signed numbers. A small parser of its own,
 * since YAML's reading of the same text differs (`{a:1}` is one key there).
 * Duplicate keys keep the last, as JSON does.
 */
export function parseJson5(source: string): unknown {
  let at = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at ${String(at)}`);
  };
  const skip = (): void => {
    for (;;) {
      const char = source[at];
      if (char === undefined) return;
      if (/\s/u.test(char) || char === "\uFEFF") at += 1;
      else if (char === "/" && source[at + 1] === "/") {
        while (at < source.length && source[at] !== "\n") at += 1;
      } else if (char === "/" && source[at + 1] === "*") {
        const close = source.indexOf("*/", at + 2);
        if (close < 0) fail("an unclosed comment");
        at = close + 2;
      } else return;
    }
  };
  const string = (): string => {
    const quote = source[at];
    at += 1;
    let out = "";
    for (;;) {
      const char = source[at];
      if (char === undefined || char === "\n") return fail("an unclosed string");
      at += 1;
      if (char === quote) return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const escaped = source[at];
      at += 1;
      if (escaped === undefined) return fail("an unclosed string");
      const simple: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
      if (escaped === "u" || escaped === "x") {
        const digits = source.slice(at, at + (escaped === "u" ? 4 : 2));
        if (!/^[0-9a-fA-F]+$/u.test(digits) || digits.length !== (escaped === "u" ? 4 : 2)) fail("a bad escape");
        out += String.fromCharCode(Number.parseInt(digits, 16));
        at += digits.length;
      } else if (escaped === "\n") {
        // A line continuation.
      } else if (escaped === "\r") {
        if (source[at] === "\n") at += 1;
      } else out += simple[escaped] ?? escaped;
    }
  };
  const identifier = (): string => {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(at));
    if (match === null) return fail("an unexpected character");
    at += match[0].length;
    return match[0];
  };
  const value = (): unknown => {
    skip();
    const char = source[at];
    if (char === "{") {
      at += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (source[at] === "}") {
          at += 1;
          return object;
        }
        const key = source[at] === '"' || source[at] === "'" ? string() : identifier();
        skip();
        if (source[at] !== ":") fail("a missing colon");
        at += 1;
        object[key] = value();
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "}") fail("a missing comma");
      }
    }
    if (char === "[") {
      at += 1;
      const array: unknown[] = [];
      for (;;) {
        skip();
        if (source[at] === "]") {
          at += 1;
          return array;
        }
        array.push(value());
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "]") fail("a missing comma");
      }
    }
    if (char === '"' || char === "'") return string();
    const number = /^[+-]?(?:0[xX][0-9a-fA-F]+|Infinity|NaN|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/u.exec(source.slice(at));
    if (number !== null) {
      at += number[0].length;
      const sign = number[0].startsWith("-") ? -1 : 1;
      const body = number[0].replace(/^[+-]/u, "");
      return sign * (/^0[xX]/u.test(body) ? Number.parseInt(body, 16) : Number(body));
    }
    const word = identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return fail(`an unexpected word ${word}`);
  };
  const parsed = value();
  skip();
  if (at < source.length) fail("text after the value");
  return parsed;
}

/** `KEY=value` lines, as both agents write `.env`: quotes taken off, `export` and comments ignored. */
export function parseDotenv(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim().replace(/^export\s+/u, "");
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null) continue;
    let value = (match[2] as string).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // Quoted: up to its closing quote, whatever follows (a comment).
      const close = value.indexOf(quote, 1);
      value = close < 0 ? value.slice(1) : value.slice(1, close);
    } else value = value.replace(/\s+#.*$/u, "");
    if (value !== "") values.set(match[1] as string, value);
  }
  return values;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (isRecord(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const tilde = (home: string, path: string): string => (path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path);
const normal = (url: string): string => url.replace(/\/+$/u, "");

/**
 * An endpoint as it may be said and stored: its origin and path. One that
 * carries a user, a password, a query or a fragment (where a key could hide)
 * is not imported, and is said only by its origin and path.
 */
function endpointOf(raw: string): { readonly shown: string; readonly url?: string; readonly problem?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { shown: "an endpoint that is not a URL", problem: "its endpoint is not a URL" };
  }
  const shown = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  if (!["http:", "https:"].includes(url.protocol)) return { shown, problem: "its endpoint is not HTTP(S)" };
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return { shown, problem: "its endpoint carries credentials or a query, which Tavi does not store" };
  return { shown, url: shown };
}

/** The preset an endpoint is, or `custom`; local servers by their usual port. */
function presetOf(baseUrl: string): string {
  const url = normal(baseUrl);
  const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.baseUrl !== "" && normal(candidate.baseUrl) === url);
  if (preset !== undefined) return preset.id;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):11434(\/v1)?$/u.test(url)) return "ollama";
  if (/^https?:\/\/(localhost|127\.0\.0\.1):1234(\/v1)?$/u.test(url)) return "lmstudio";
  return "custom";
}

/** The other agents' names for the providers Tavi has presets of. */
const PROVIDER_PRESET: Readonly<Record<string, string>> = {
  openrouter: "openrouter",
  openai: "openai",
  "openai-api": "openai",
  anthropic: "anthropic",
  google: "gemini",
  gemini: "gemini",
  ollama: "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
};

/** A value or a `${VAR}` reference, resolved against the agent's own variables, with where it came from. */
function resolved(
  value: unknown,
  vars: ReadonlyMap<string, { readonly value: string; readonly from: string }>,
  inline: string,
): { readonly value: string; readonly from: string } | undefined {
  const given = text(value);
  if (given === undefined) return undefined;
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(given);
  if (reference === null) return { value: given, from: inline };
  const found = vars.get(reference[1] as string);
  return found === undefined ? undefined : { value: found.value, from: `${reference[1] as string} in ${found.from}` };
}

/** The preset's documented key variables, in the agent's own variables. */
function keyVariable(
  preset: string,
  vars: ReadonlyMap<string, { readonly value: string; readonly from: string }>,
): { readonly value: string; readonly from: string } | undefined {
  for (const name of (ONBOARDING_ENV_KEYS as Readonly<Record<string, readonly string[]>>)[preset] ?? []) {
    const found = vars.get(name);
    if (found !== undefined) return { value: found.value, from: `${name} in ${found.from}` };
  }
  return undefined;
}

async function variablesFrom(
  files: ImportFiles,
  paths: readonly string[],
  extra: Readonly<Record<string, unknown>> | undefined,
  extraFrom: string,
): Promise<Map<string, { readonly value: string; readonly from: string }>> {
  const vars = new Map<string, { readonly value: string; readonly from: string }>();
  for (const [name, value] of Object.entries(extra ?? {}))
    if (typeof value === "string" && value !== "") vars.set(name, { value, from: extraFrom });
  for (const path of [...new Set(paths)]) {
    const raw = await files.readText(path);
    if (raw === undefined) continue;
    for (const [name, value] of parseDotenv(raw)) if (!vars.has(name)) vars.set(name, { value, from: tilde(files.home, path) });
  }
  return vars;
}

/** What a connection needs to be imported: a key unless it is a local server. */
function needsKey(preset: string): boolean {
  return MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === preset)?.localOnly !== true;
}

// ------------------------------------------------------------------ the two agents

async function openClaw(files: ImportFiles): Promise<FoundImport | undefined> {
  const root = files.env["OPENCLAW_STATE_DIR"] ?? join(files.home, ".openclaw");
  const configPath = files.env["OPENCLAW_CONFIG_PATH"] ?? join(root, "openclaw.json");
  const raw = await files.readText(configPath);
  if (raw === undefined) return undefined;
  let config: Readonly<Record<string, unknown>>;
  try {
    config = record(parseJson5(raw)) ?? {};
  } catch {
    return {
      finding: {
        source: "openclaw",
        root: tilde(files.home, root),
        connections: [{ name: tilde(files.home, configPath), preset: "custom", isDefault: false, problem: "its config could not be read" }],
      },
      secrets: new Map(),
    };
  }
  const shown = tilde(files.home, configPath);
  const vars = await variablesFrom(
    files,
    [join(root, ".env"), join(configPath, "..", ".env")],
    record(record(config["env"])?.["vars"]),
    `${shown} (env.vars)`,
  );
  const defaults = record(record(config["agents"])?.["defaults"]);
  const primary = text(defaults?.["model"]) ?? text(record(defaults?.["model"])?.["primary"]);
  const [primaryProvider, ...primaryModel] = (primary ?? "").split("/");
  const connections: ImportedConnection[] = [];
  const secrets = new Map<string, string>();
  const providers = record(record(config["models"])?.["providers"]) ?? {};
  for (const [name, value] of Object.entries(providers)) {
    const provider = record(value) ?? {};
    const endpoint = text(provider["baseUrl"]) === undefined ? undefined : endpointOf(text(provider["baseUrl"]) as string);
    const baseUrl = endpoint?.url;
    const api = text(provider["api"]);
    const preset = endpoint === undefined ? (PROVIDER_PRESET[name] ?? "custom") : baseUrl === undefined ? "custom" : presetOf(baseUrl);
    if (endpoint?.problem !== undefined) {
      connections.push({ name, preset, baseUrl: endpoint.shown, isDefault: name === primaryProvider, problem: endpoint.problem });
      continue;
    }
    const models = Array.isArray(provider["models"]) ? provider["models"] : [];
    const model = name === primaryProvider && primaryModel.length > 0 ? primaryModel.join("/") : text(record(models[0])?.["id"]);
    const isDefault = name === primaryProvider;
    if (api !== undefined && api !== "openai-completions") {
      connections.push({
        name,
        preset,
        isDefault,
        ...(model === undefined ? {} : { model }),
        problem: `its ${api} endpoint is not OpenAI-compatible chat, which Tavi speaks`,
      });
      continue;
    }
    if (preset === "custom" && baseUrl === undefined) {
      connections.push({ name, preset, isDefault, problem: "it names no endpoint" });
      continue;
    }
    const keyless = provider["auth"] === "none" || !needsKey(preset);
    const key = keyless
      ? undefined
      : (resolved(provider["apiKey"], vars, `${shown} (models.providers.${name}.apiKey)`) ?? keyVariable(preset, vars));
    if (key !== undefined) secrets.set(name, key.value);
    connections.push({
      name,
      preset,
      isDefault,
      ...(preset === "custom" && baseUrl !== undefined ? { baseUrl } : {}),
      ...(model === undefined ? {} : { model }),
      ...(keyless ? { keyless: true } : {}),
      ...(key === undefined ? {} : { keyFrom: key.from }),
      ...(key === undefined && !keyless
        ? { problem: "its key is not in a file Tavi reads (OpenClaw's own credential store is never read)" }
        : {}),
    });
  }
  // The default on a bundled provider, keyed by its variable.
  if (primaryProvider !== undefined && primaryProvider !== "" && providers[primaryProvider] === undefined) {
    const preset = PROVIDER_PRESET[primaryProvider];
    if (preset !== undefined) {
      const keyless = !needsKey(preset);
      const key = keyless ? undefined : keyVariable(preset, vars);
      if (key !== undefined) secrets.set(primaryProvider, key.value);
      connections.push({
        name: primaryProvider,
        preset,
        isDefault: true,
        ...(primaryModel.length > 0 ? { model: primaryModel.join("/") } : {}),
        ...(keyless ? { keyless: true } : {}),
        ...(key === undefined ? {} : { keyFrom: key.from }),
        ...(key === undefined && !keyless
          ? { problem: "its key is not in a file Tavi reads (OpenClaw's own credential store is never read)" }
          : {}),
      });
    }
  }
  const telegram = record(record(config["channels"])?.["telegram"]);
  let telegramFrom: string | undefined;
  const inlineToken = resolved(telegram?.["botToken"], vars, `${shown} (channels.telegram.botToken)`);
  const tokenFile = text(telegram?.["tokenFile"]);
  // The user's own config names it: `~` is their home, a relative path the config's directory.
  const tokenPath =
    tokenFile === undefined
      ? undefined
      : /^~[\\/]/.test(tokenFile)
        ? join(files.home, tokenFile.slice(2))
        : isAbsolute(tokenFile)
          ? tokenFile
          : join(dirname(configPath), tokenFile);
  const fromFile = tokenPath === undefined ? undefined : text(await files.readText(tokenPath));
  const token = inlineToken?.value ?? fromFile ?? vars.get("TELEGRAM_BOT_TOKEN")?.value;
  if (token !== undefined) {
    secrets.set("telegram", token);
    telegramFrom =
      inlineToken?.from ??
      (fromFile !== undefined && tokenFile !== undefined
        ? tokenFile
        : `TELEGRAM_BOT_TOKEN in ${vars.get("TELEGRAM_BOT_TOKEN")?.from ?? shown}`);
  }
  return {
    finding: { source: "openclaw", root: tilde(files.home, root), connections, ...(telegramFrom === undefined ? {} : { telegramFrom }) },
    secrets,
  };
}

async function hermes(files: ImportFiles): Promise<FoundImport | undefined> {
  const root = files.env["HERMES_HOME"] ?? join(files.home, ".hermes");
  const configPath = join(root, "config.yaml");
  const raw = await files.readText(configPath);
  const envPath = join(root, ".env");
  const envText = await files.readText(envPath);
  if (raw === undefined && envText === undefined) return undefined;
  let config: Readonly<Record<string, unknown>> = {};
  try {
    config = record(raw === undefined ? undefined : parseYaml(raw)) ?? {};
  } catch {
    return {
      finding: {
        source: "hermes",
        root: tilde(files.home, root),
        connections: [{ name: tilde(files.home, configPath), preset: "custom", isDefault: false, problem: "its config could not be read" }],
      },
      secrets: new Map(),
    };
  }
  const shown = tilde(files.home, configPath);
  const vars = await variablesFrom(files, [envPath], undefined, "");
  const connections: ImportedConnection[] = [];
  const secrets = new Map<string, string>();
  const add = (
    name: string,
    presetGiven: string | undefined,
    fields: { readonly baseUrl?: string; readonly model?: string; readonly isDefault: boolean; readonly apiKey?: unknown },
  ): void => {
    const endpoint = fields.baseUrl === undefined ? undefined : endpointOf(fields.baseUrl);
    const preset = presetGiven ?? (endpoint?.url === undefined ? "custom" : presetOf(endpoint.url));
    if (endpoint?.problem !== undefined) {
      connections.push({ name, preset, baseUrl: endpoint.shown, isDefault: fields.isDefault, problem: endpoint.problem });
      return;
    }
    const keyless = !needsKey(preset);
    const key = keyless ? undefined : (resolved(fields.apiKey, vars, `${shown} (${name}.api_key)`) ?? keyVariable(preset, vars));
    if (key !== undefined) secrets.set(name, key.value);
    connections.push({
      name,
      preset,
      isDefault: fields.isDefault,
      ...(preset === "custom" && endpoint?.url !== undefined ? { baseUrl: endpoint.url } : {}),
      ...(fields.model === undefined ? {} : { model: fields.model }),
      ...(keyless ? { keyless: true } : {}),
      ...(key === undefined ? {} : { keyFrom: key.from }),
      ...(key === undefined && !keyless ? { problem: "its key is not in a file Tavi reads (Hermes's own sign-ins are never read)" } : {}),
    });
  };
  const model = record(config["model"]);
  const provider = text(model?.["provider"]);
  const defaultModel = text(model?.["default"]);
  const baseUrl = text(model?.["base_url"]);
  const named = record(config["providers"]) ?? {};
  for (const [name, value] of Object.entries(named)) {
    const entry = record(value) ?? {};
    const api = text(entry["api"]);
    if (api === undefined) continue;
    const models = Array.isArray(entry["models"]) ? entry["models"] : [];
    const isDefault = name === provider;
    add(name, undefined, {
      baseUrl: api,
      isDefault,
      apiKey: entry["api_key"],
      ...(isDefault && defaultModel !== undefined
        ? { model: defaultModel }
        : text(models[0]) === undefined
          ? {}
          : { model: text(models[0]) as string }),
    });
  }
  for (const value of Array.isArray(config["custom_providers"]) ? config["custom_providers"] : []) {
    const entry = record(value) ?? {};
    const name = text(entry["name"]);
    const url = text(entry["base_url"]);
    if (name === undefined || url === undefined || named[name] !== undefined) continue;
    const entryModel = text(entry["model"]);
    add(name, undefined, {
      baseUrl: url,
      isDefault: name === provider,
      apiKey: entry["api_key"],
      ...(entryModel === undefined ? {} : { model: entryModel }),
    });
  }
  if (provider !== undefined && named[provider] === undefined && !connections.some((connection) => connection.name === provider)) {
    const own = baseUrl !== undefined && baseUrl !== "";
    const preset = own ? undefined : PROVIDER_PRESET[provider];
    if (own || preset !== undefined)
      add(provider, preset, {
        ...(own ? { baseUrl } : {}),
        isDefault: true,
        ...(defaultModel === undefined ? {} : { model: defaultModel }),
      });
    else connections.push({ name: provider, preset: "custom", isDefault: true, problem: `${provider} is a sign-in Tavi does not offer` });
  }
  const token = vars.get("TELEGRAM_BOT_TOKEN");
  if (token !== undefined) secrets.set("telegram", token.value);
  return {
    finding: {
      source: "hermes",
      root: tilde(files.home, root),
      connections,
      ...(token === undefined ? {} : { telegramFrom: `TELEGRAM_BOT_TOKEN in ${token.from}` }),
    },
    secrets,
  };
}

/** The installs found, OpenClaw's then Hermes's; `only` keeps one. */
export async function findImports(files: ImportFiles, only?: ImportSource): Promise<readonly FoundImport[]> {
  const found: FoundImport[] = [];
  for (const source of only === undefined ? IMPORT_SOURCES : [only]) {
    const one = source === "openclaw" ? await openClaw(files) : await hermes(files);
    if (one !== undefined) found.push(one);
  }
  return found;
}

// ------------------------------------------------------------------ the run

/** The finding in lines, by name and place only: what a dry run prints, and what an import asks about. */
export function describeImport(finding: ImportFinding): readonly string[] {
  const lines = [`${SOURCE_NAMES[finding.source]} (${finding.root}):`];
  if (finding.connections.length === 0 && finding.telegramFrom === undefined) lines.push("  nothing Tavi can import");
  for (const connection of finding.connections) {
    const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === connection.preset)?.name ?? connection.preset;
    const where = connection.baseUrl === undefined ? preset : `${preset} at ${connection.baseUrl}`;
    const model = connection.model === undefined ? "" : `, ${connection.model}${connection.isDefault ? " (its default)" : ""}`;
    lines.push(
      connection.problem === undefined
        ? `  ${GLYPHS.done} ${connection.name} → ${where}${model}; key: ${connection.keyless === true ? "none needed" : (connection.keyFrom ?? "none found")}`
        : `  ${GLYPHS.todo} ${connection.name} → ${where}${model}: not imported, ${connection.problem}`,
    );
  }
  if (finding.telegramFrom !== undefined) lines.push(`  ${GLYPHS.done} Telegram bot; token: ${finding.telegramFrom}`);
  return lines;
}

export interface ImportRun {
  readonly workspaceId: string;
  /** The person agreed to copy keys and the bot token into Tavi's credentials file. */
  readonly secrets: boolean;
}

export interface ImportOutcome {
  readonly connected: readonly string[];
  /** Imported without its key, which the person declined to copy. */
  readonly withoutKey: readonly string[];
  readonly defaultSet?: string;
  readonly telegram?: "added" | "needs-owner" | "declined" | { readonly problem: string };
}

/**
 * Import what was found: each connection through `onboarding connect-key` (a
 * keyless local server always; one with a key only with consent), the other
 * agent's default made Tavi's once it verifies, and only while Tavi has no
 * working model; the Telegram bot added and tested on a running owner, with
 * consent. Pairing it stays the channels step's.
 */
export async function runImport(
  transport: OnboardTransport,
  found: FoundImport,
  run: ImportRun,
  say: (line: string) => void,
): Promise<ImportOutcome> {
  const connected: string[] = [];
  const withoutKey: string[] = [];
  let defaultSet: string | undefined;
  let defaultTarget: { readonly connectionId: string; readonly model: string } | undefined;
  for (const connection of found.finding.connections) {
    if (connection.problem !== undefined) continue;
    // Keyless as the dry run said (a local server, or `auth: "none"`): the placeholder the server ignores.
    const key = connection.keyless === true ? "local-no-key" : run.secrets ? found.secrets.get(connection.name) : undefined;
    if (key === undefined) {
      withoutKey.push(connection.name);
      say(`${GLYPHS.todo} ${connection.name}: its key was not copied; add it with tavi setup model.`);
      continue;
    }
    try {
      const answer = await transport.request<OnboardingConnectAnswer>(
        "onboarding",
        {
          action: "connect-key",
          workspaceId: run.workspaceId,
          preset: connection.preset,
          key,
          ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
        },
        60_000,
      );
      connected.push(answer.connectionId);
      say(
        `${GLYPHS.done} ${connection.name} → ${answer.connectionId}${answer.models.length > 0 ? ` (${String(answer.models.length)} models)` : ""}`,
      );
      const model = connection.model ?? answer.suggested?.main;
      if (connection.isDefault && model !== undefined) defaultTarget = { connectionId: answer.connectionId, model };
    } catch (error) {
      say(`${GLYPHS.failed} ${connection.name}: ${errorMessage(error)}`);
    }
  }
  if (defaultTarget !== undefined) {
    const status = await transport.request<OnboardingStatus>("onboarding", {
      action: "status",
      workspaceId: run.workspaceId,
      surface: "cli",
    });
    // A working model stays: an import never moves a verified default.
    if (status.steps.find((step) => step.kind === "model")?.state !== "done") {
      // A verification that cannot run is no pass: the default is not set.
      const verified = await transport
        .request<{ readonly results: readonly { readonly ok: boolean; readonly advice?: string }[] }>(
          "onboarding",
          { action: "verify", workspaceId: run.workspaceId, role: "main", target: defaultTarget },
          60_000,
        )
        .catch(() => undefined);
      if (verified?.results[0]?.ok === true) {
        await transport.request("models", { action: "set-default", workspaceId: run.workspaceId, ...defaultTarget });
        defaultSet = `${defaultTarget.connectionId} · ${defaultTarget.model}`;
        say(`${GLYPHS.done} Default model: ${defaultSet} (verified)`);
      } else
        say(
          `${GLYPHS.todo} ${defaultTarget.model} did not answer${verified?.results[0]?.advice === undefined ? "" : `: ${verified.results[0].advice}`}; choose a model with tavi setup model.`,
        );
    }
  }
  let telegram: ImportOutcome["telegram"];
  const token = found.secrets.get("telegram");
  if (found.finding.telegramFrom !== undefined && token !== undefined) {
    if (!run.secrets) {
      telegram = "declined";
      say(`${GLYPHS.todo} Telegram bot: its token was not copied; add it with tavi setup channels.`);
    } else if (!transport.attached) {
      telegram = "needs-owner";
      say(`${GLYPHS.todo} Telegram: adding the bot needs a running owner; start tavi serve, then run tavi onboard import again.`);
    } else {
      const status = await transport.request<OnboardingStatus>("onboarding", {
        action: "status",
        workspaceId: run.workspaceId,
        surface: "cli",
      });
      const own = status.steps.find((step) => step.kind === "channels")?.createdRef;
      // The other agent's bot token is Telegram's first secret field, whichever plugin provides Telegram here.
      const descriptor = (await channelCatalog(transport)).find((candidate) => candidate.providerId === "telegram");
      const field = descriptor === undefined ? undefined : channelSecretFields(descriptor)[0]?.key;
      const added: { readonly detail?: string; readonly problem?: string } =
        descriptor === undefined || field === undefined
          ? { problem: "no Telegram channel is installed here" }
          : await addChannel(transport, run.workspaceId, descriptor, { [field]: token }, own);
      telegram = added.problem === undefined ? "added" : { problem: added.problem };
      say(
        added.problem === undefined
          ? `${GLYPHS.done} Telegram bot added${added.detail === undefined ? "" : ` (${added.detail})`}; pair yourself with tavi setup channels.`
          : `${GLYPHS.failed} Telegram: ${added.problem}`,
      );
    }
  }
  return { connected, withoutKey, ...(defaultSet === undefined ? {} : { defaultSet }), ...(telegram === undefined ? {} : { telegram }) };
}
