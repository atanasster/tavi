import { TaviError, downloaderCommand, secretLookingName, shellCommand } from "@tavi/contracts";
import { errorMessage, isRecord } from "@tavi/contracts/util";

import { readJsonBody } from "../../shared/json-body.js";
import { DEFAULT_NPM_REGISTRY } from "./npm.js";
import { normalizePypiName } from "./pypi.js";

/**
 * `tavi mcp import <file>`: reads the
 * `mcpServers` another client keeps — Claude Desktop, Claude Code, Cursor, or
 * VS Code's `servers` — and proposes each server as `tavi mcp add` would add
 * it, never as the file runs it:
 * - `npx -y pkg` becomes `--npm pkg@<resolved exact>`: the whole closure is
 *   fetched and pinned at install, with no install script run;
 * - a literal secret, in a variable or a header, moves into a credential, and
 *   the source file is not changed;
 * - `uvx pkg` becomes `--pypi pkg==<resolved exact>`: wheels only,
 *   hash-pinned with uv;
 * - an entry that cannot be rewritten is listed with why, and skipped.
 * Nothing is approved: each server is a proposed version, reviewed as any
 * other. Only the operator's own CLI reaches this module.
 */

/** One server as the source file names it. */
export interface McpImportEntry {
  readonly name: string;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** A secret moved out of the file into a credential, by the setting that reads it. */
interface McpImportSecret {
  readonly setting: string;
  readonly value: string;
}

/** A server to add: `tavi mcp add <slug> <args>`, its secrets stored and set after. */
interface McpImportProposal {
  readonly name: string;
  readonly slug: string;
  /** The add's arguments after the slug: the form, its flags, and the server's argv after `--`. */
  readonly args: readonly string[];
  readonly secrets: readonly McpImportSecret[];
  /** Settings the file only pointed at (`${input:…}`, `${env:…}`): declared, for the operator to set. */
  readonly unset: readonly string[];
  readonly notes: readonly string[];
}

export interface McpImportSkip {
  readonly name: string;
  readonly reason: string;
}

export interface McpImportPlan {
  readonly proposals: readonly McpImportProposal[];
  readonly skipped: readonly McpImportSkip[];
}

/** JSON with VS Code's comments and trailing commas: both removed outside strings. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += text[index] === "\\" ? 2 : 1);
      out += text.slice(start, index + 1);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
    } else out += char;
  }
  // A comma before a closing bracket, outside strings (the strings are matched first so they pass unchanged).
  return JSON.parse(
    out.replace(
      /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
      (_match, string: string | undefined, close: string | undefined) => string ?? close ?? "",
    ),
  );
}

/**
 * Every server a client's file names, in file order: `mcpServers` at the top
 * (Claude Desktop, Cursor, a project's `.mcp.json`) and under each project
 * (`~/.claude.json`), `servers` (VS Code's `mcp.json`) and `mcp.servers`
 * (VS Code's settings). A name already seen is listed once.
 */
export function readMcpServers(text: string): { readonly entries: readonly McpImportEntry[]; readonly skipped: readonly McpImportSkip[] } {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new TaviError("INVALID_INPUT", `the file is not JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new TaviError("INVALID_INPUT", "the file holds no mcpServers");
  const groups: unknown[] = [parsed["mcpServers"], parsed["servers"], isRecord(parsed["mcp"]) ? parsed["mcp"]["servers"] : undefined];
  if (isRecord(parsed["projects"]))
    for (const project of Object.values(parsed["projects"])) if (isRecord(project)) groups.push(project["mcpServers"]);
  const entries: McpImportEntry[] = [];
  const skipped: McpImportSkip[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!isRecord(group)) continue;
    for (const [name, entry] of Object.entries(group)) {
      if (seen.has(name)) {
        skipped.push({ name, reason: "named again later in the file; the first is proposed" });
        continue;
      }
      seen.add(name);
      if (!isRecord(entry)) skipped.push({ name, reason: "not a server entry" });
      else entries.push({ name, entry });
    }
  }
  if (entries.length === 0 && skipped.length === 0)
    throw new TaviError("INVALID_INPUT", "the file holds no mcpServers (nor VS Code's servers)");
  return { entries, skipped };
}

/** A server name from the file's: lowercase letters and digits, starting with a letter, at most 19 characters. */
export function slugFor(name: string): string | undefined {
  const plain = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 19);
  return plain === "" ? undefined : plain;
}

/** A setting's name from a variable's or a header's (`X-API-Key` → `X_API_Key`). */
const settingFor = (name: string): string => {
  const plain = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z]/.test(plain) ? plain : `s_${plain}`;
};

/** `${input:…}` or `${env:…}`: a value the other client fills when it starts, never a literal. */
const placeholder = (value: string): boolean => /\$\{(?:input|env):[^}]+\}/.test(value);
/** A value that is one placeholder and nothing else: it becomes a setting with nothing lost. */
const onlyPlaceholder = (value: string): boolean => /^\$\{(?:input|env):[^}]+\}$/.test(value);

/** An npm tag or exact version as the registry resolves it; a range is refused (it would not name what runs). */
export type NpmResolver = (name: string, tag: string) => Promise<string>;

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The registry's answer for `name@tag` (a dist-tag or an exact version): its exact version. */
export function npmResolver(options: { readonly registry?: string; readonly fetch?: typeof fetch } = {}): NpmResolver {
  const registry = (options.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  return async (name, tag) => {
    const response = await fetcher(`${registry}/${name.replace("/", "%2f")}/${encodeURIComponent(tag)}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new TaviError("NOT_FOUND", `npm has no ${name}@${tag} (HTTP ${String(response.status)})`);
    const version = ((await readJsonBody(response)) as { readonly version?: unknown } | null)?.version;
    if (typeof version !== "string" || !EXACT.test(version))
      throw new TaviError("UNAVAILABLE", `npm named no exact version for ${name}@${tag}`);
    return version;
  };
}

/** PyPI's JSON for a project lists every release: a large project's runs to ~10 MB. */
const PYPI_PROJECT_MAX_BYTES = 32 * 1024 * 1024;

/** A PyPI project's exact version for what `uvx` named: the latest, or the one given, as PyPI publishes it. */
export type PypiResolver = (name: string, version: string | undefined) => Promise<string>;

/** PyPI's JSON API: `name`'s latest version, or `version` checked to exist. */
export function pypiResolver(options: { readonly fetch?: typeof fetch } = {}): PypiResolver {
  const fetcher = options.fetch ?? fetch;
  return async (name, version) => {
    // Asked by its normal name: PyPI redirects any other spelling, and a redirect is refused.
    const response = await fetcher(
      `https://pypi.org/pypi/${encodeURIComponent(normalizePypiName(name))}${version === undefined ? "" : `/${encodeURIComponent(version)}`}/json`,
      { redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new TaviError(
        "NOT_FOUND",
        `PyPI has no ${name}${version === undefined ? "" : `==${version}`} (HTTP ${String(response.status)})`,
      );
    const found = ((await readJsonBody(response, PYPI_PROJECT_MAX_BYTES)) as { readonly info?: { readonly version?: unknown } } | null)
      ?.info?.version;
    if (typeof found !== "string" || found === "") throw new TaviError("UNAVAILABLE", `PyPI named no version for ${name}`);
    return found;
  };
}

/** `pkg[@version|==version] args…` after `uvx`: the project and the server's own argv. */
function uvxPackage(
  args: readonly string[],
): { readonly name: string; readonly version?: string; readonly args: readonly string[] } | string {
  const spec = args[0];
  if (spec === undefined) return "uvx names no package";
  if (spec.startsWith("-")) return `uvx ${spec} cannot be rewritten; add the server by hand with --pypi`;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:(?:@|==)([0-9][0-9A-Za-z.+!-]*))?$/.exec(spec);
  if (match === null) return `${JSON.stringify(spec)} is not a PyPI project with an exact version; add it by hand with --pypi`;
  return { name: match[1] as string, ...(match[2] === undefined ? {} : { version: match[2] }), args: args.slice(1) };
}

/** `[flags] pkg[@tag|@version] args…` after `npx`: the package and the server's own argv. */
function npxPackage(args: readonly string[]): { readonly name: string; readonly tag: string; readonly args: readonly string[] } | string {
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const flag = args[index] as string;
    if (flag !== "-y" && flag !== "--yes" && flag !== "-q" && flag !== "--quiet")
      return `npx ${flag} cannot be rewritten; add the server by hand with --npm`;
    index += 1;
  }
  const spec = args[index];
  if (spec === undefined) return "npx names no package";
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const tag = at > 0 ? spec.slice(at + 1) : "latest";
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    return `${JSON.stringify(spec)} is not an npm package from the public registry`;
  if (!EXACT.test(tag) && !/^[a-z][a-z0-9._-]*$/i.test(tag))
    return `${name}@${tag} is a range; give an exact version and add it by hand with --npm`;
  return { name, tag, args: args.slice(index + 1) };
}

/**
 * Why a value looks like a secret whatever its name says — a URL carrying a
 * password, a well-known token's prefix, a JWT, a bearer token — or undefined.
 */
function secretInValue(value: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)) return "a URL with a password";
  if (
    /^(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}$|^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$|^xox[abprs]-[A-Za-z0-9-]{10,}$|^AKIA[0-9A-Z]{16}$|^glpat-[A-Za-z0-9_-]{20}$/.test(
      value,
    )
  )
    return "an API token";
  if (/^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/.test(value)) return "a signed token (JWT)";
  if (/^bearer\s+\S{8,}$/i.test(value)) return "a bearer token";
  return undefined;
}

/** A flag whose value is a secret: its name ends in one (`--api-key`, `--token`, `--client-secret`), not `--token-file` or `--author`. */
const SECRET_FLAG =
  /^-{1,2}(?:[a-z0-9]+[-_])*(?:api[-_]?key|apikey|key|token|secret|password|passwd|pass|pat|access[-_]?key|private[-_]?key)$/i;

/**
 * An argument that carries a secret: one whose value looks like one, or the
 * value of a secret-named flag (`--api-key sk…`, `--token=…`). A server is
 * then skipped: Tavi passes a secret only in an environment variable.
 */
function secretArgument(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const kind = secretInValue(inline ?? arg);
    if (kind !== undefined) return `argument ${String(index + 1)} carries ${kind}`;
    if (SECRET_FLAG.test(flag)) {
      const value = inline ?? args[index + 1];
      if (value !== undefined && value !== "" && !value.startsWith("-")) return `its ${flag} argument carries a secret`;
    }
  }
  return undefined;
}

/** The variables: literal ones stay, secret-looking ones move into credentials, placeholders become settings to set. */
function envArgs(env: unknown, secrets: McpImportSecret[], unset: string[]): readonly string[] | string {
  if (env === undefined) return [];
  if (!isRecord(env)) return "its env is not a map of strings";
  const args: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") return `its variable ${name} is not a string`;
    const setting = settingFor(name);
    if (onlyPlaceholder(value)) {
      unset.push(setting);
      args.push("--env", `${name}=@${setting}`);
    } else if (placeholder(value)) return `its variable ${name} mixes a placeholder into its value`;
    // A secret by its name, or by its value (a password in a URL, a token) whatever the name says: then its setting is
    // declared a credential explicitly.
    else if (secretLookingName(name) || secretInValue(value) !== undefined) {
      secrets.push({ setting, value });
      args.push("--env", `${name}=@${setting}`, ...(secretLookingName(name) ? [] : ["--secret", setting]));
    } else if (value.startsWith("@")) return `its variable ${name}'s value starts with @, which add reads as a setting`;
    else args.push("--env", `${name}=${value}`);
  }
  return args;
}

/** The headers: a secret (a secret-looking name, or `Authorization`) moves into a credential, its `Bearer ` kept as a prefix. */
function headerArgs(headers: unknown, secrets: McpImportSecret[], unset: string[]): readonly string[] | string {
  if (headers === undefined) return [];
  if (!isRecord(headers)) return "its headers are not a map of strings";
  const args: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") return `its header ${name} is not a string`;
    const setting = settingFor(name);
    const bearer = /^bearer\s+/i.exec(value)?.[0];
    const rest = bearer === undefined ? value : value.slice(bearer.length);
    if (onlyPlaceholder(rest)) {
      unset.push(setting);
      args.push("--header", `${name}=${bearer ?? ""}@${setting}`);
    } else if (placeholder(value)) return `its header ${name} mixes a placeholder into its value`;
    else if (secretLookingName(name) || /^authorization$/i.test(name) || bearer !== undefined) {
      secrets.push({ setting, value: rest });
      args.push("--header", `${name}=${bearer ?? ""}@${setting}`);
    } else args.push("--header", `${name}=${value}`);
  }
  return args;
}

/** One entry's proposal, or why it is skipped. */
async function propose(
  name: string,
  slug: string,
  entry: Readonly<Record<string, unknown>>,
  resolve: NpmResolver,
  resolvePypi: PypiResolver,
): Promise<McpImportProposal | McpImportSkip> {
  const secrets: McpImportSecret[] = [];
  const unset: string[] = [];
  const notes: string[] = [];
  const skip = (reason: string): McpImportSkip => ({ name, reason });
  const type = entry["type"];
  if (typeof entry["url"] === "string" || type === "http" || type === "sse" || type === "streamable-http") {
    if (type === "sse") return skip("an SSE server (the older HTTP transport) is not supported; add its Streamable HTTP address by hand");
    const given = entry["url"];
    if (typeof given !== "string") return skip("it names no url");
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      return skip(`${JSON.stringify(given)} is not a URL`);
    }
    // Plain http needs `lan`, the operator's grant, never an import's.
    if (url.protocol === "http:") return skip(`plain http to ${url.host}: if it is on your network, add it by hand with --lan`);
    if (url.protocol !== "https:") return skip(`${url.protocol} is not an MCP address`);
    if (url.username !== "" || url.password !== "")
      return skip("its url carries a user and password; add it by hand with the secret in a header");
    const keyed = [...url.searchParams.keys()].find(secretLookingName);
    if (keyed !== undefined) return skip(`its url carries a secret (${keyed}); add it by hand with the secret in a header`);
    const headers = headerArgs(entry["headers"], secrets, unset);
    if (typeof headers === "string") return skip(headers);
    return { name, slug, args: ["--url", url.href, ...headers], secrets, unset, notes };
  }
  const command = entry["command"];
  const rawArgs = entry["args"] ?? [];
  if (typeof command !== "string" || command === "") return skip("it names neither a command nor a url");
  if (!Array.isArray(rawArgs) || !rawArgs.every((arg): arg is string => typeof arg === "string")) return skip("its args are not strings");
  if ([command, ...rawArgs].some(placeholder)) return skip("its command line holds a placeholder (${input:…} or ${env:…}); add it by hand");
  const secretArg = secretArgument(rawArgs);
  if (secretArg !== undefined)
    return skip(
      `${secretArg}, which would be written into the server's manifest; add it by hand with the secret in an environment variable`,
    );
  const program = command.split("/").at(-1) ?? command;
  if (typeof entry["cwd"] === "string") notes.push(`its cwd (${entry["cwd"]}) is not kept: a server runs in its own home`);
  const env = envArgs(entry["env"], secrets, unset);
  if (typeof env === "string") return skip(env);
  if (program === "npx") {
    const found = npxPackage(rawArgs);
    if (typeof found === "string") return skip(found);
    let version: string;
    try {
      version = await resolve(found.name, found.tag);
    } catch (error) {
      return skip(errorMessage(error));
    }
    if (found.tag !== version) notes.push(`npx ran ${found.name}@${found.tag}; pinned to ${version}`);
    return {
      name,
      slug,
      args: ["--npm", `${found.name}@${version}`, ...env, ...(found.args.length === 0 ? [] : ["--", ...found.args])],
      secrets,
      unset,
      notes,
    };
  }
  if (program === "uvx") {
    const found = uvxPackage(rawArgs);
    if (typeof found === "string") return skip(found);
    let version: string;
    try {
      version = await resolvePypi(found.name, found.version);
    } catch (error) {
      return skip(errorMessage(error));
    }
    if (found.version === undefined) notes.push(`uvx ran the latest ${found.name}; pinned to ${version}`);
    return {
      name,
      slug,
      args: ["--pypi", `${found.name}==${version}`, ...env, ...(found.args.length === 0 ? [] : ["--", ...found.args])],
      secrets,
      unset,
      notes,
    };
  }
  const refused = downloaderCommand([command, ...rawArgs]) ?? shellCommand([command, ...rawArgs]);
  if (refused !== undefined) return skip(refused);
  if (command.startsWith("/"))
    return { name, slug, args: ["--command", command, ...env, ...(rawArgs.length === 0 ? [] : ["--", ...rawArgs])], secrets, unset, notes };
  return skip(`${program} runs a local server: add it by hand with --dir <its folder> -- ${[command, ...rawArgs].join(" ")}`);
}

/**
 * The plan for a file's servers: a proposal for each that can be rewritten,
 * named from the file and never colliding with `taken` (the servers already
 * installed) or each other, and the rest listed with why.
 */
export async function planMcpImport(
  text: string,
  options: { readonly taken: ReadonlySet<string>; readonly resolve: NpmResolver; readonly resolvePypi: PypiResolver },
): Promise<McpImportPlan> {
  const read = readMcpServers(text);
  const proposals: McpImportProposal[] = [];
  const skipped: McpImportSkip[] = [...read.skipped];
  const used = new Set(options.taken);
  for (const { name, entry } of read.entries) {
    const slug = slugFor(name);
    if (slug === undefined) {
      skipped.push({ name, reason: "its name has no letter to name a server by; add it by hand" });
      continue;
    }
    if (used.has(slug)) {
      skipped.push({ name, reason: `a server named ${slug} already exists; add it by hand with another name` });
      continue;
    }
    const outcome = await propose(name, slug, entry, options.resolve, options.resolvePypi);
    if ("reason" in outcome) skipped.push(outcome);
    else {
      used.add(slug);
      proposals.push(outcome);
    }
  }
  return { proposals, skipped };
}
