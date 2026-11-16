import type { FetchLike } from "@modelcontextprotocol/client";
import { MCP_PACKAGE_BOUNDS, McpSlugSchema, TaviError } from "@tavi/contracts";
import { BodyTooLargeError, readBoundedBody, sha256Hex } from "@tavi/node-kit";
import { z } from "zod";

import { serverLine } from "./results.js";
import { parseEnv, parseHeader } from "./specs.js";

/**
 * The MCP Registry: search over its `v0.1` API, and
 * each entry's `server.json` — its packages (npm, PyPI, `.mcpb`) and remotes
 * — as Tavi's install forms, a secret input a credential setting. Its text is
 * the publisher's, cleaned, and never a reason to trust a server: an entry is
 * added as a proposed version, probed in its sandbox and reviewed like any.
 */

/** The official registry; the operator may name another (`tavi mcp registry <url>`). */
export const MCP_REGISTRY_DEFAULT = "https://registry.modelcontextprotocol.io";
/** The owner setting that holds the operator's registry, when not the default. */
export const MCP_REGISTRY_SETTING = "mcp.registryUrl";
/** The most a registry answer may be. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** The most redirects a download follows, each checked again. */
const MAX_REDIRECTS = 5;
/** Entries per search page. */
const MCP_REGISTRY_PAGE = 30;

/** A registry base: https, no credentials, no query; its trailing slash dropped. */
export function registryBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TaviError("INVALID_INPUT", `${JSON.stringify(url)} is not a registry address`);
  }
  if (parsed.protocol !== "https:") throw new TaviError("INVALID_INPUT", "a registry is reached over https");
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "")
    throw new TaviError("INVALID_INPUT", "a registry address carries no credentials, query or fragment");
  return parsed.href.replace(/\/+$/, "");
}

const VariableSchema = z.object({ isSecret: z.boolean().optional(), isRequired: z.boolean().optional() });

const InputSchema = z.object({
  name: z.string().max(256).optional(),
  /** What a value's `{placeholder}` stands for: a secret one is a credential. */
  variables: z.record(z.string(), VariableSchema).optional(),
  description: z.string().max(4000).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  value: z.string().max(4096).optional(),
  default: z.string().max(4096).optional(),
  valueHint: z.string().max(256).optional(),
  type: z.string().max(32).optional(),
});
type Input = z.infer<typeof InputSchema>;

const PackageSchema = z.object({
  registryType: z.string().max(32),
  registryBaseUrl: z.string().max(2048).optional(),
  identifier: z.string().min(1).max(2048),
  version: z.string().max(64).optional(),
  fileSha256: z.string().max(128).optional(),
  transport: z
    .object({ type: z.string().max(32), url: z.string().max(2048).optional() })
    .loose()
    .optional(),
  runtimeArguments: z.array(InputSchema).max(64).optional(),
  packageArguments: z.array(InputSchema).max(64).optional(),
  environmentVariables: z.array(InputSchema).max(64).optional(),
});

const RemoteSchema = z.object({
  type: z.string().max(32),
  url: z.string().max(2048),
  headers: z.array(InputSchema).max(32).optional(),
});

/** A `server.json`, as far as Tavi reads it. */
export const ServerJsonSchema = z.object({
  name: z.string().min(1).max(256),
  title: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  version: z.string().min(1).max(64),
  websiteUrl: z.string().max(2048).optional(),
  repository: z
    .object({ url: z.string().max(2048).optional() })
    .loose()
    .optional(),
  packages: z.array(PackageSchema).max(32).optional(),
  remotes: z.array(RemoteSchema).max(32).optional(),
});
export type ServerJson = z.infer<typeof ServerJsonSchema>;

const ListSchema = z.object({
  servers: z.array(z.object({ server: z.unknown() }).loose()).max(500),
  metadata: z
    .object({ nextCursor: z.string().max(1024).optional() })
    .loose()
    .optional(),
});

/** One way to add an entry: an install form with what it needs set, or why it cannot be added. */
interface RegistryOption {
  /** `npm`, `pypi`, `mcpb`, `remote`; a second of a kind is `npm-2` … */
  readonly key: string;
  readonly kind: "npm" | "pypi" | "mcpb" | "remote";
  /** What `tavi mcp add` it is, in words: the package and version, the bundle's file, or the address. */
  readonly summary: string;
  /** Settings to set after adding, credentials among them. */
  readonly settings: readonly string[];
  readonly credentials: readonly string[];
  readonly notes: readonly string[];
}

/** An entry as the Discover view and `tavi mcp search` show it: its words cleaned, never a trust signal. */
export interface RegistryEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly version: string;
  /** `installable`, `remote`, and `<type>-unsupported` for each package Tavi cannot run (`oci`, `nuget`, `cargo` …). */
  readonly labels: readonly string[];
  readonly options: readonly RegistryOption[];
  /** Why each package or remote Tavi cannot add was left out. */
  readonly unsupported: readonly string[];
  readonly websiteUrl?: string;
  readonly repositoryUrl?: string;
  /** The server name Tavi suggests (`[a-z][a-z0-9]*`, 19 at most). */
  readonly slug: string;
}

/** The registry's words for a person: cleaned, on one line, cut. */
const shown = serverLine;

/** A web address the registry gives, shown only when it is https. */
const webAddress = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).protocol === "https:" ? shown(url, 500) : undefined;
  } catch {
    return undefined;
  }
};

/** A setting's name for an input: its name in lower case, other characters as `_`. */
function settingFor(name: string): string {
  const word = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(word) ? word : `s_${word}`).slice(0, 64);
}

/** The server name Tavi suggests for an entry: its last part, letters and digits only. */
export function suggestedSlug(name: string): string {
  const last = (name.split("/").at(-1) ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .replace(/(?:mcp|server)+$/g, "");
  const slug = (last === "" ? "server" : last).slice(0, 19);
  return McpSlugSchema.safeParse(slug).success ? slug : "server";
}

/** An exact version, as a package's or a plugin's. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLACEHOLDER = /\{[^}]*\}/;

/** Whether an input is secret: marked so, or its value a placeholder whose variable is. */
const secretInput = (input: Input, value: string | undefined): boolean => {
  if (input.isSecret === true) return true;
  const placeholder = value === undefined ? undefined : /\{([^}]*)\}/.exec(value)?.[1];
  return placeholder !== undefined && input.variables?.[placeholder]?.isSecret === true;
};

/** What a `tavi mcp add` would be made of: `env` and `headers` specs, extra arguments, and the settings they name. */
export interface RegistryForm {
  readonly form:
    | { readonly kind: "npm"; readonly spec: string; readonly args: readonly string[] }
    | { readonly kind: "pypi"; readonly spec: string; readonly args: readonly string[] }
    | { readonly kind: "mcpb"; readonly url: string; readonly sha256: string; readonly args: readonly string[] }
    | { readonly kind: "url"; readonly url: string; readonly headers: readonly string[] };
  /** `KEY=value` or `KEY=@setting`, as `--env` takes them. */
  readonly env: readonly string[];
  /** Settings to declare as credentials, whatever their names look like. */
  readonly credentials: readonly string[];
  readonly settings: readonly string[];
  readonly notes: readonly string[];
}

/** A package's arguments as argv: static values only; a required one with none, or a secret, makes it unsupported. */
function argumentsOf(inputs: readonly Input[]): readonly string[] {
  const argv: string[] = [];
  for (const input of inputs) {
    const value = input.value ?? input.default;
    const label = input.name ?? input.valueHint ?? "an argument";
    if (input.isSecret === true)
      throw new TaviError(
        "UNSUPPORTED",
        `it takes the secret ${shown(label, 60)} as an argument; Tavi passes a secret only in an environment variable`,
      );
    if (value !== undefined && PLACEHOLDER.test(value)) {
      if (input.isRequired === true)
        throw new TaviError(
          "UNSUPPORTED",
          `its argument ${shown(label, 60)} is filled in from a setting, which Tavi passes only in an environment variable`,
        );
      continue;
    }
    if (input.type === "named") {
      if (input.name === undefined) continue;
      if (value === undefined) {
        if (input.isRequired === true) throw new TaviError("UNSUPPORTED", `it needs a value for ${shown(label, 60)}`);
        continue;
      }
      argv.push(input.name, value);
    } else if (value !== undefined) argv.push(value);
    else if (input.isRequired === true) throw new TaviError("UNSUPPORTED", `it needs a value for ${shown(label, 60)}`);
  }
  return argv;
}

/** Environment variables as `--env` specs: a secret or a required one with no value a setting; an optional one with none left out. */
function environmentOf(inputs: readonly Input[]): Pick<RegistryForm, "env" | "credentials" | "settings"> {
  const env: string[] = [];
  const credentials: string[] = [];
  const settings: string[] = [];
  for (const input of inputs) {
    const name = input.name;
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new TaviError("UNSUPPORTED", `its environment variable ${JSON.stringify(shown(name ?? "", 60))} is not a variable name`);
    const value = input.value ?? input.default;
    const secret = secretInput(input, value);
    const fromSetting = secret || value === undefined || PLACEHOLDER.test(value);
    if (!fromSetting) {
      // The spec is read back as `--env` reads it: a literal it would take for a setting is not passed.
      const spec = `${name}=${value}`;
      const read = parseEnv(spec).source;
      if (!("value" in read) || read.value !== value)
        throw new TaviError("UNSUPPORTED", `its environment variable ${name}'s value reads as a setting`);
      env.push(spec);
      continue;
    }
    if (value === undefined && input.isRequired !== true && !secret) continue;
    if (value !== undefined && PLACEHOLDER.test(value) && !/^\{[^}]*\}$/.test(value))
      throw new TaviError("UNSUPPORTED", `its environment variable ${name} mixes a setting into other text`);
    const setting = settingFor(name);
    env.push(`${name}=@${setting}`);
    settings.push(setting);
    if (secret) credentials.push(setting);
  }
  return { env, credentials, settings };
}

/** Headers as `--header` specs: a secret or a templated one (`Bearer {token}`) a credential setting. */
function headersOf(inputs: readonly Input[]): {
  readonly headers: readonly string[];
  readonly credentials: readonly string[];
  readonly settings: readonly string[];
} {
  const headers: string[] = [];
  const credentials: string[] = [];
  for (const input of inputs) {
    const name = input.name;
    if (name === undefined || !/^[A-Za-z0-9-]+$/.test(name))
      throw new TaviError("UNSUPPORTED", `its header ${JSON.stringify(shown(name ?? "", 60))} is not a header name`);
    const value = input.value ?? input.default;
    const template = value === undefined ? undefined : /^([^{}]*)\{[^}]*\}$/.exec(value);
    if (value !== undefined && !PLACEHOLDER.test(value) && !secretInput(input, value)) {
      // Read back as `--header` reads it: a literal it would take for a credential is not passed.
      const read = parseHeader(`${name}=${value}`).source;
      if (!("value" in read) || read.value !== value)
        throw new TaviError("UNSUPPORTED", `its header ${name}'s value reads as a credential`);
      headers.push(`${name}=${value}`);
      continue;
    }
    if (value === undefined && input.isRequired !== true && !secretInput(input, value)) continue;
    // A credential header is its prefix, ending in a space (`Bearer `), then the secret; anything else is refused.
    const prefix = template?.[1] ?? "";
    if (value !== undefined && (template === null || (prefix !== "" && !/\s$/.test(prefix))))
      throw new TaviError("UNSUPPORTED", `its header ${name} mixes a setting into other text`);
    const setting = settingFor(name);
    headers.push(`${name}=${prefix}@${setting}`);
    credentials.push(setting);
  }
  return { headers, credentials, settings: credentials };
}

/**
 * Each way to add `server` (its packages, then its remotes), and why the rest
 * cannot be: npm and PyPI at an exact version from the public registries, a
 * bundle with its file's SHA-256, a Streamable HTTP remote over https; a
 * package that serves HTTP, an SSE remote, an address with variables, and
 * any other package type are left out, each saying why.
 */
export function registryForms(server: ServerJson): {
  readonly forms: ReadonlyMap<string, RegistryForm>;
  readonly unsupported: readonly string[];
  readonly unsupportedTypes: readonly string[];
} {
  const forms = new Map<string, RegistryForm>();
  const unsupported: string[] = [];
  const unsupportedTypes = new Set<string>();
  const keyFor = (kind: string): string => {
    let key = kind;
    for (let index = 2; forms.has(key); index += 1) key = `${kind}-${String(index)}`;
    return key;
  };
  for (const entry of server.packages ?? []) {
    const type = entry.registryType.toLowerCase();
    const what = `${shown(type, 20)} package ${shown(entry.identifier, 120)}`;
    try {
      if (type !== "npm" && type !== "pypi" && type !== "mcpb") {
        unsupportedTypes.add(/^[a-z0-9]{1,20}$/.test(type) ? type : "other");
        throw new TaviError("UNSUPPORTED", "Tavi does not run this kind of package");
      }
      if (entry.transport !== undefined && entry.transport.type !== "stdio")
        throw new TaviError("UNSUPPORTED", `it serves ${shown(entry.transport.type, 30)} itself; Tavi runs packaged servers over stdio`);
      const environment = environmentOf(entry.environmentVariables ?? []);
      const args = argumentsOf(entry.packageArguments ?? []);
      const notes = (entry.runtimeArguments ?? []).length === 0 ? [] : ["its runtime arguments are not used: Tavi runs the package itself"];
      let form: RegistryForm["form"];
      if (type === "mcpb") {
        const sha256 = entry.fileSha256?.toLowerCase();
        if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256))
          throw new TaviError("UNSUPPORTED", "it carries no fileSha256 to check the bundle against");
        if (!plainAddress(entry.identifier, "https:")) throw new TaviError("UNSUPPORTED", "its bundle is not at an https address");
        form = { kind: "mcpb", url: entry.identifier, sha256, args };
      } else {
        const version = entry.version ?? server.version;
        if (!EXACT_VERSION.test(version)) throw new TaviError("UNSUPPORTED", `its version ${shown(version, 40)} is not exact`);
        const base = entry.registryBaseUrl?.replace(/\/+$/, "");
        if (type === "npm" && base !== undefined && base !== "https://registry.npmjs.org")
          throw new TaviError("UNSUPPORTED", "it is not on the public npm registry");
        if (type === "pypi" && base !== undefined && base !== "https://pypi.org" && base !== "https://pypi.org/simple")
          throw new TaviError("UNSUPPORTED", "it is not on public PyPI");
        form =
          type === "npm"
            ? { kind: "npm", spec: `${entry.identifier}@${version}`, args }
            : { kind: "pypi", spec: `${entry.identifier}==${version}`, args };
      }
      forms.set(keyFor(type), { form, ...environment, notes });
    } catch (error) {
      if (!(error instanceof TaviError)) throw error;
      unsupported.push(`${what}: ${error.message}`);
    }
  }
  for (const remote of server.remotes ?? []) {
    const what = `remote ${shown(remote.url, 200)}`;
    try {
      if (remote.type !== "streamable-http")
        throw new TaviError(
          "UNSUPPORTED",
          remote.type === "sse" ? "an SSE server; Tavi reaches Streamable HTTP only" : `a ${shown(remote.type, 30)} remote`,
        );
      if (PLACEHOLDER.test(remote.url)) throw new TaviError("UNSUPPORTED", "its address has variables");
      if (!plainAddress(remote.url, "https:")) throw new TaviError("UNSUPPORTED", "its address is not https");
      const { headers, credentials, settings } = headersOf(remote.headers ?? []);
      forms.set(keyFor("remote"), { form: { kind: "url", url: remote.url, headers }, env: [], credentials, settings, notes: [] });
    } catch (error) {
      if (!(error instanceof TaviError)) throw error;
      unsupported.push(`${what}: ${error.message}`);
    }
  }
  return { forms, unsupported, unsupportedTypes: [...unsupportedTypes] };
}

/** Whether `url` parses, with `protocol` and no credentials in it. */
const plainAddress = (url: string, protocol: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === protocol && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
};

/** An entry as shown: its words cleaned, its labels, and each way to add it. */
export function registryEntry(server: ServerJson, mapped: ReturnType<typeof registryForms> = registryForms(server)): RegistryEntry {
  const { forms, unsupported, unsupportedTypes } = mapped;
  const options: RegistryOption[] = [...forms].map(([key, entry]) => ({
    key,
    kind: entry.form.kind === "url" ? "remote" : entry.form.kind,
    summary: shown(
      entry.form.kind === "url"
        ? entry.form.url
        : entry.form.kind === "mcpb"
          ? `${entry.form.url} (sha256 ${entry.form.sha256.slice(0, 12)}…)`
          : entry.form.spec,
      300,
    ),
    settings: entry.settings.filter((setting) => !entry.credentials.includes(setting)),
    credentials: entry.credentials,
    notes: entry.notes,
  }));
  const labels = [
    ...(options.length > 0 ? ["installable"] : []),
    ...(options.some((option) => option.kind === "remote") ? ["remote"] : []),
    ...unsupportedTypes.map((type) => `${type}-unsupported`),
  ];
  const website = webAddress(server.websiteUrl);
  const repository = webAddress(server.repository?.url);
  return {
    name: shown(server.name, 200),
    ...(server.title === undefined ? {} : { title: shown(server.title, 120) }),
    description: shown(server.description ?? "", 500),
    version: shown(server.version, 64),
    labels,
    options,
    unsupported: unsupported.map((line) => shown(line, 300)),
    ...(website === undefined ? {} : { websiteUrl: website }),
    ...(repository === undefined ? {} : { repositoryUrl: repository }),
    slug: suggestedSlug(server.name),
  };
}

/** A JSON answer from the registry: at most `MAX_ANSWER_BYTES`, no redirect. */
async function registryJson(fetch: FetchLike, url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, ...(signal === undefined ? {} : { signal }) });
  if (response.status === 404) throw new TaviError("NOT_FOUND", "the registry has no such server");
  if (!response.ok) throw new TaviError("UNAVAILABLE", `the registry answered HTTP ${String(response.status)}`);
  const body = await boundedBody(response, MAX_ANSWER_BYTES, "the registry's answer");
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new TaviError("UNAVAILABLE", "the registry's answer is not JSON");
  }
}

/** A response's body, refused past `max` bytes. */
async function boundedBody(response: Response, max: number, what: string): Promise<Buffer> {
  try {
    return (await readBoundedBody(response, max)).bytes;
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      throw new TaviError("INVALID_INPUT", `${what} is larger than ${String(Math.round(max / 1024 / 1024))} MB`);
    throw error;
  }
}

/** A search of the registry: the latest version of each matching server, a page at a time. */
export async function searchRegistry(
  fetch: FetchLike,
  base: string,
  query: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ readonly entries: readonly RegistryEntry[]; readonly next?: string }> {
  const url = new URL(`${registryBase(base)}/v0.1/servers`);
  if (query.trim() !== "") url.searchParams.set("search", query.trim());
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(MCP_REGISTRY_PAGE));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const parsed = ListSchema.safeParse(await registryJson(fetch, url.href, signal));
  if (!parsed.success) throw new TaviError("UNAVAILABLE", "the registry's answer is not a server list");
  const entries: RegistryEntry[] = [];
  for (const item of parsed.data.servers) {
    const server = ServerJsonSchema.safeParse(item.server);
    // An entry Tavi cannot read is left out, not guessed at.
    if (server.success) entries.push(registryEntry(server.data));
  }
  const next = parsed.data.metadata?.nextCursor;
  return { entries, ...(next === undefined || next === "" ? {} : { next }) };
}

/** One server's `server.json` at a version (`latest` for the newest). */
export async function registryServer(
  fetch: FetchLike,
  base: string,
  name: string,
  version: string,
  signal?: AbortSignal,
): Promise<ServerJson> {
  const answer = await registryJson(
    fetch,
    `${registryBase(base)}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    signal,
  );
  const server = ServerJsonSchema.safeParse((answer as { readonly server?: unknown } | null)?.server ?? answer);
  if (!server.success) throw new TaviError("UNAVAILABLE", "the registry's answer is not a server.json Tavi reads");
  if (server.data.name !== name)
    throw new TaviError("CONFLICT", `the registry answered for ${shown(server.data.name, 200)}, not ${shown(name, 200)}`);
  if (version !== "latest" && server.data.version !== version)
    throw new TaviError("CONFLICT", `the registry answered with version ${shown(server.data.version, 64)}, not ${shown(version, 64)}`);
  return server.data;
}

/**
 * A bundle the registry points to, fetched under the guard (each redirect
 * checked again, https only) within the package limit, and checked against
 * the `fileSha256` its entry gives.
 */
export async function downloadBundle(fetch: FetchLike, url: string, sha256: string, signal?: AbortSignal): Promise<Buffer> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!plainAddress(at, "https:")) throw new TaviError("NOT_AUTHORIZED", "a bundle is downloaded over https only");
    const response = await fetch(at, { redirect: "manual", ...(signal === undefined ? {} : { signal }) } as RequestInit);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new TaviError("UNAVAILABLE", "the bundle's address redirected nowhere");
      at = new URL(location, at).href;
      continue;
    }
    if (!response.ok) throw new TaviError("UNAVAILABLE", `the bundle's address answered HTTP ${String(response.status)}`);
    const bundle = await boundedBody(response, MCP_PACKAGE_BOUNDS.maxBytes, "the bundle");
    if (sha256Hex(bundle) !== sha256)
      throw new TaviError("CONFLICT", "the bundle downloaded is not the one the registry names (its SHA-256 differs)");
    return bundle;
  }
  throw new TaviError("UNAVAILABLE", `the bundle's address redirected more than ${String(MAX_REDIRECTS)} times`);
}
