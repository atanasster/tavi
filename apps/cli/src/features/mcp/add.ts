import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

import type { FetchLike } from "@modelcontextprotocol/client";

import { bundleManifest, mcpbServer, readMcpbFile, type McpbArchive, type McpbManifest, type McpbServer } from "./mcpb.js";
import { serverLine } from "./results.js";
import { taviDescription } from "./descriptions.js";
import { parseEnv, parseHeader } from "./specs.js";
import { EXACT_VERSION, downloadBundle, registryEntry, registryForms, registryServer } from "./registry.js";
import { fetchNpmServer, parsePackageSpec, type NpmFetchOptions, type NpmFetchResult } from "./npm.js";
import {
  fetchPypiServer,
  findUv,
  managedInterpreter,
  parsePypiSpec,
  PYTHON_BOOTSTRAP,
  uvEnvironment,
  type PypiFetchOptions,
  type PypiFetchResult,
} from "./pypi.js";
import { challengedMetadataUrl } from "./oauth-provider.js";
import { presetOf } from "./presets/index.js";

import {
  MCP_ABI,
  MCP_PLUGIN_PREFIX,
  McpSlugSchema,
  PLUGIN_MANIFEST_FILE,
  PROVIDER_ABI,
  PluginManifestSchema,
  TaviError,
  mcpFilesystemProblems,
  mcpFolderProblem,
  secretLookingName,
  type McpBlock,
  type McpPresetId,
  type PluginConfigField,
  type PluginManifest,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { writeJsonAtomic } from "@tavi/node-kit";

/**
 * `tavi mcp add`: writes an MCP server's
 * plugin directory from the operator's flags, for the registry to install as
 * a **proposed** version. No server code runs here, and nothing is approved:
 * the probe and the review come after. Only the operator's own CLI
 * reaches this module.
 */

/** An OAuth server's optional pre-registered client: CIMD or registration otherwise. */
const OWN_CLIENT_FIELDS: Readonly<Record<string, PluginConfigField>> = {
  clientId: {
    type: "string",
    required: false,
    description: "A client registered at the server's authorization server (optional: CIMD or registration otherwise)",
  },
  clientSecret: { type: "credential", required: false, description: "That client's secret, if it has one" },
};
/** The install forms: a remote url, an npm package, a local directory, or an external binary. */

export type McpAddForm =
  | { readonly kind: "url"; readonly url: string; readonly headers: readonly string[]; readonly lan: boolean; readonly oauth?: boolean }
  | { readonly kind: "npm"; readonly spec: string; readonly args: readonly string[] }
  /** A Python server from PyPI: wheels only, hash-pinned with uv, a pinned interpreter. */
  | { readonly kind: "pypi"; readonly spec: string; readonly args: readonly string[] }
  | { readonly kind: "dir"; readonly path: string; readonly argv: readonly string[] }
  | { readonly kind: "command"; readonly path: string; readonly args: readonly string[] }
  /** A `.mcpb` bundle: its files copied with the server, its manifest mapped; `args` follow its own. */
  | { readonly kind: "mcpb"; readonly path: string; readonly args: readonly string[] }
  /** A reviewed template: its settings are set after, with `tavi plugins config`. */
  | { readonly kind: "preset"; readonly preset: McpPresetId }
  /** An MCP Registry entry: one of its packages or remotes, as `option` names it, read from the registry again. */
  | { readonly kind: "registry"; readonly name: string; readonly version: string; readonly option: string };

export interface McpAddOptions {
  readonly slug: string;
  readonly form: McpAddForm;
  readonly version?: string;
  readonly name?: string;
  readonly description?: string;
  /** stdio: `KEY=value` literals, or `KEY=@setting` from a setting (a credential when the name looks secret). */
  readonly env?: readonly string[];
  /** stdio: domains the server may reach. */
  readonly domains?: readonly string[];
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly exposure?: McpBlock["exposure"];
  /** Settings declared as credentials whatever their names look like (a registry entry's secret inputs). */
  readonly credentials?: readonly string[];
}

/** Where the plugin directory is written before the registry installs it. */
export interface McpAddPlacement {
  readonly dataDirectory: string;
  readonly home?: string;
  /** The MCP Registry a `registry` form is read from, and the guarded fetch that reaches it. */
  readonly registry?: { readonly fetch: FetchLike; readonly base: string };
}

export { parseHeader } from "./specs.js";

/**
 * The manifest `add` writes. Every setting a header or variable names is
 * declared: a header's, and a secret-looking variable's, as a credential.
 * For `--dir`, argv elements naming a file in the directory become
 * `${package}/<path>` (the copied directory).
 */
export function mcpAddManifest(
  options: McpAddOptions,
  files?: (relative: string) => boolean,
  fetched?: NpmFetchResult | PypiFetchResult,
  interpreter?: PypiFetchResult["interpreter"],
  bundle?: { readonly manifest: McpbManifest; readonly server: McpbServer; readonly integrity: string },
): PluginManifest {
  const slug = McpSlugSchema.safeParse(options.slug);
  if (!slug.success)
    throw new TaviError(
      "INVALID_INPUT",
      `${JSON.stringify(options.slug)} is not a server name: lowercase letters and digits, starting with a letter, at most 19 characters`,
    );
  const config: Record<string, PluginConfigField> = {};
  const declare = (setting: string, type: PluginConfigField["type"], description: string): void => {
    if (config[setting] === undefined) config[setting] = { type, required: true, description };
  };
  // A bundle's own settings and environment first; the operator's --env wins over the bundle's.
  if (bundle !== undefined) Object.assign(config, bundle.server.config);
  const env = Object.fromEntries([
    ...Object.entries(bundle?.server.env ?? {}),
    ...(options.env ?? []).map(parseEnv).map(({ name, source }) => {
      if ("setting" in source)
        declare(
          source.setting,
          secretLookingName(name) || options.credentials?.includes(source.setting) === true ? "credential" : "string",
          `The server's ${name}`,
        );
      return [name, source] as const;
    }),
  ]);
  let block: Record<string, unknown>;
  let format: PluginManifest["provenance"]["format"];
  const form = options.form;
  const preset = form.kind === "preset" ? presetOf(form.preset) : undefined;
  if (form.kind === "registry") throw new TaviError("INTERNAL", "a registry entry is read into its own form first");
  if (form.kind === "preset") {
    if (preset === undefined) throw new TaviError("UNSUPPORTED", `no preset ${form.preset} in this build`);
    Object.assign(config, preset.config);
    // A server that registers no clients itself is given one of the person's own.
    if (preset.block.auth === "oauth") Object.assign(config, OWN_CLIENT_FIELDS);
    block = { abi: MCP_ABI, ...preset.block, preset: preset.id };
    format = "mcp-remote";
  } else if (form.kind === "url") {
    const headers = Object.fromEntries(
      form.headers.map(parseHeader).map(({ name, source }) => {
        if ("setting" in source) declare(source.setting, "credential", `The ${name} header's secret`);
        return [name, source];
      }),
    );
    const authenticated = Object.values(headers).some((source) => "setting" in source);
    // OAuth: an optional pre-registered client, else CIMD or DCR at login.
    if (form.oauth === true) Object.assign(config, OWN_CLIENT_FIELDS);
    block = {
      abi: MCP_ABI,
      transport: "http",
      url: { value: form.url },
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(form.lan ? { network: { lan: true } } : {}),
      auth: form.oauth === true ? "oauth" : authenticated ? "headers" : "none",
    };
    format = "mcp-remote";
  } else {
    const stdio = {
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...((options.domains ?? []).length === 0 ? {} : { network: { domains: [...(options.domains ?? [])] } }),
      ...((options.read ?? []).length + (options.write ?? []).length === 0
        ? {}
        : { filesystem: { read: [...(options.read ?? [])], write: [...(options.write ?? [])] } }),
    };
    if (form.kind === "command") {
      block = { abi: MCP_ABI, transport: "stdio", command: [form.path, ...form.args], external: true, ...stdio };
      format = "mcp-command";
    } else if (form.kind === "mcpb") {
      if (bundle === undefined) throw new TaviError("INTERNAL", "a bundle's manifest needs its bundle");
      // A Python bundle runs on the uv-managed interpreter, pinned now.
      if (bundle.server.runtime === "python" && interpreter === undefined)
        throw new TaviError("INTERNAL", "a Python bundle needs its pinned interpreter");
      block = {
        abi: MCP_ABI,
        transport: "stdio",
        command: [...bundle.server.command, ...form.args],
        ...(bundle.server.runtime === "python" ? { interpreter } : {}),
        ...stdio,
      };
      format = "mcp-mcpb";
    } else if (form.kind === "npm") {
      if (fetched === undefined || "interpreter" in fetched)
        throw new TaviError("INTERNAL", "an npm server's manifest needs its fetched package");
      block = {
        abi: MCP_ABI,
        transport: "stdio",
        package: { registry: "npm", name: fetched.name, version: fetched.version, integrity: fetched.integrity },
        command: ["node", `\${package}/${fetched.entry}`, ...form.args],
        ...stdio,
      };
      format = "mcp-npm";
    } else if (form.kind === "pypi") {
      if (fetched === undefined || !("interpreter" in fetched))
        throw new TaviError("INTERNAL", "a Python server's manifest needs its fetched package");
      // The pinned interpreter, isolated (-I: no user site, no PYTHON* variables; -B: no bytecode written), runs the
      // package's console script from the installed tree.
      block = {
        abi: MCP_ABI,
        transport: "stdio",
        package: { registry: "pypi", name: fetched.name, version: fetched.version, integrity: fetched.integrity },
        interpreter: fetched.interpreter,
        command: ["python", "-I", "-B", "-c", PYTHON_BOOTSTRAP, "${package}/site", fetched.entry, ...form.args],
        ...stdio,
      };
      format = "mcp-pypi";
    } else {
      // Paths into the copied directory become `${package}/…`; `node` and `python` stay as they are.
      const argv = form.argv.map((arg, index) =>
        (index === 0 && (arg === "node" || arg === "python")) || isAbsolute(arg) || files?.(normalize(arg)) !== true
          ? arg
          : `\${package}/${normalize(arg)}`,
      );
      // `python` is the uv-managed interpreter, pinned now.
      block = {
        abi: MCP_ABI,
        transport: "stdio",
        command: argv,
        ...(argv[0] === "python" && interpreter !== undefined ? { interpreter } : {}),
        ...stdio,
      };
      format = "mcp-dir";
    }
  }
  if (options.exposure !== undefined) block = { ...block, exposure: options.exposure };
  const parsed = PluginManifestSchema.safeParse({
    schemaVersion: 2,
    abi: PROVIDER_ABI,
    // npm's closure is listed by its SRI integrity; a Python server's pins are `mcp.package` and its tree's requirements.txt.
    // A bundle is listed by its own file's integrity.
    provenance: {
      format,
      packages:
        bundle !== undefined
          ? [
              {
                name: bundlePackageName(bundle.manifest.name),
                version: bundle.manifest.version,
                integrity: bundle.integrity,
                license: serverLine(bundle.manifest.license ?? "", 128) || "UNLICENSED",
              },
            ]
          : fetched === undefined || "interpreter" in fetched
            ? []
            : [
                {
                  name: fetched.name,
                  version: fetched.version,
                  integrity: fetched.integrity,
                  license: serverLine(fetched.license, 128) || "UNLICENSED",
                },
              ],
    },
    id: `${MCP_PLUGIN_PREFIX}${slug.data}`,
    version: options.version ?? bundle?.manifest.version ?? "1.0.0",
    // A server's name is the operator's (its slug unless given) or a reviewed preset's — never a bundle's or a
    // listing's, which reach the model in `tools.search`'s description. Its description may be the
    // publisher's, cleaned: a person reads it, never the model.
    name: options.name ?? preset?.name ?? slug.data,
    description:
      options.description ??
      preset?.description ??
      (bundle?.manifest.description === undefined ? undefined : serverLine(bundle.manifest.description, 500) || undefined) ??
      taviDescription(form, slug.data),
    config,
    mcp: block,
  });
  if (!parsed.success)
    throw new TaviError("INVALID_INPUT", `the server cannot be added: ${zodIssues(parsed.error, "manifest").join("; ")}`);
  return parsed.data;
}

/**
 * Writes the plugin directory under `<data>/mcp/.add/<uuid>` and returns it,
 * for the registry to install; the caller removes it afterwards. A `--dir`
 * server's files are copied to `server/` (the plugin limits apply when the
 * registry reads them).
 */
export async function writeMcpPluginDirectory(
  options: McpAddOptions,
  placement: McpAddPlacement & { readonly npm?: NpmFetchOptions; readonly pypi?: PypiFetchOptions },
): Promise<{ readonly directory: string; readonly manifest: PluginManifest; readonly notes: readonly string[] }> {
  const form = options.form;
  if (form.kind === "registry") return await fromRegistry(options, form, placement);
  if (form.kind === "dir") {
    if (!isAbsolute(form.path) || !existsSync(form.path) || !lstatSync(form.path).isDirectory())
      throw new TaviError("NOT_FOUND", `no server directory at ${form.path}`);
    // Checked before anything is copied: a server's files are never $HOME, Tavi's data or another tool's credentials.
    const refused = mcpFolderProblem(normalize(form.path), { home: placement.home ?? homedir(), dataDirectory: placement.dataDirectory });
    if (refused !== undefined) throw new TaviError("INVALID_INPUT", `the server cannot be added from there: ${refused}`);
  }
  if (form.kind === "command") {
    if (!isAbsolute(form.path)) throw new TaviError("INVALID_INPUT", "--command takes the binary's absolute path");
    if (!existsSync(form.path) || !statSync(form.path).isFile()) throw new TaviError("NOT_FOUND", `no file at ${form.path}`);
  }
  // A bundle is read whole — and its manifest mapped — before anything is written.
  let bundle: { readonly archive: McpbArchive; readonly manifest: McpbManifest; readonly server: McpbServer } | undefined;
  if (form.kind === "mcpb") {
    if (!isAbsolute(form.path) || !existsSync(form.path)) throw new TaviError("NOT_FOUND", `no bundle at ${form.path}`);
    const archive = readMcpbFile(form.path);
    const manifest = bundleManifest(archive.files);
    bundle = { archive, manifest, server: mcpbServer(manifest, archive.files) };
  }
  const files =
    form.kind === "dir"
      ? (relative: string): boolean => !relative.startsWith("..") && !isAbsolute(relative) && existsSync(join(form.path, relative))
      : undefined;
  if (form.kind === "pypi") parsePypiSpec(form.spec);
  // A local Python server runs on the uv-managed interpreter, pinned now.
  let interpreter: PypiFetchResult["interpreter"] | undefined;
  if ((form.kind === "dir" && form.argv[0] === "python") || bundle?.server.runtime === "python") {
    const uv = placement.pypi?.uv ?? findUv();
    if (uv === undefined)
      throw new TaviError(
        "CAPABILITY_MISSING",
        "uv was not found on PATH; a Python server runs on an interpreter uv manages (`tavi doctor` checks it)",
      );
    // Asked from an empty directory: nothing in the server's own folder chooses the interpreter.
    const neutral = mkdtempSync(join(tmpdir(), "tavi-uv-"));
    try {
      interpreter = await managedInterpreter(uv, uvEnvironment(placement.pypi?.uvEnv), neutral);
    } finally {
      rmSync(neutral, { recursive: true, force: true });
    }
  }
  // Checked before anything is fetched: the manifest's own rules, with a placeholder package.
  const mapped =
    bundle === undefined ? undefined : { manifest: bundle.manifest, server: bundle.server, integrity: bundle.archive.integrity };
  if (form.kind !== "npm" && form.kind !== "pypi")
    checkedManifest(mcpAddManifest(options, files, undefined, interpreter, mapped), placement);
  const directory = join(placement.dataDirectory, "mcp", ".add", randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    let fetched: NpmFetchResult | PypiFetchResult | undefined;
    if (form.kind === "npm" || form.kind === "pypi") {
      const packageDirectory = join(directory, "package");
      mkdirSync(packageDirectory, { mode: 0o700 });
      fetched =
        form.kind === "npm"
          ? await fetchNpmServer(parsePackageSpec(form.spec), packageDirectory, placement.npm ?? {})
          : await fetchPypiServer(parsePypiSpec(form.spec), packageDirectory, placement.pypi ?? {});
    }
    const manifest = checkedManifest(mcpAddManifest(options, files, fetched, interpreter, mapped), placement);
    if (form.kind === "dir") cpSync(form.path, join(directory, "server"), { recursive: true, verbatimSymlinks: true });
    for (const file of bundle?.archive.files ?? []) {
      const target = join(directory, "server", file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.data, { mode: file.executable ? 0o755 : 0o644 });
    }
    writeJsonAtomic(join(directory, PLUGIN_MANIFEST_FILE), manifest, { indent: 2, trailingNewline: true });
    const notes =
      bundle !== undefined
        ? [
            `${String(bundle.archive.files.length)} files from the bundle ${serverLine(bundle.manifest.name, 120)} ${bundle.manifest.version} (${bundle.archive.integrity.slice(0, 31)}…); nothing in it ran`,
            bundle.archive.signature === undefined
              ? "unsigned"
              : `signed (${bundle.archive.signature.scheme}, ${String(bundle.archive.signature.bytes)} bytes): shown only — the signature is not checked, and it is not a reason to trust the bundle`,
            ...(interpreter === undefined ? [] : [`runs on Python ${interpreter.version} (${interpreter.path})`]),
            ...bundle.server.notes,
          ]
        : fetched === undefined
          ? []
          : "interpreter" in fetched
            ? [
                `${String(fetched.files)} packages from PyPI, wheels only, every one pinned by its hash; nothing was built`,
                `runs on Python ${fetched.interpreter.version} (${fetched.interpreter.path})`,
                `license: ${serverLine(fetched.license, 128)}`,
                ...fetched.native.map((file) => `prebuilt native code: ${file}`),
              ]
            : [
                `${String(fetched.files)} packages from npm, every one with its integrity; no install script ran`,
                ...fetched.native.map((file) => `prebuilt native code: ${file}`),
                ...fetched.deprecated.map((line) => `deprecated: ${line}`),
              ];
    return { directory, manifest, notes };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A registry entry added: its `server.json` read again from the
 * registry — never taken from the page that showed it — and the chosen
 * package or remote added as its own form would be, its inputs as settings
 * (a secret one a credential). A bundle is downloaded under the guard and
 * checked against its SHA-256 first. The entry's words are the publisher's:
 * the server is proposed, probed and reviewed like any other.
 */
/** How long the add waits for a registry remote to say how it signs in. */
const SIGN_IN_PROBE_MS = 10_000;

async function fromRegistry(
  options: McpAddOptions,
  form: Extract<McpAddForm, { readonly kind: "registry" }>,
  placement: McpAddPlacement & { readonly npm?: NpmFetchOptions; readonly pypi?: PypiFetchOptions },
): Promise<{ readonly directory: string; readonly manifest: PluginManifest; readonly notes: readonly string[] }> {
  const registry = placement.registry;
  if (registry === undefined) throw new TaviError("UNAVAILABLE", "the MCP Registry is not reachable here");
  const server = await registryServer(registry.fetch, registry.base, form.name, form.version);
  const mapped = registryForms(server);
  const entry = mapped.forms.get(form.option);
  const shown = registryEntry(server, mapped);
  if (entry === undefined)
    throw new TaviError(
      "NOT_FOUND",
      `${shown.name} ${shown.version} has no way to add it as ${form.option}${shown.options.length === 0 ? "" : `; it has ${shown.options.map((option) => option.key).join(", ")}`}`,
    );
  let bundle: string | undefined;
  let concrete: McpAddForm;
  let oauth = false;
  if (entry.form.kind === "mcpb") {
    const bytes = await downloadBundle(registry.fetch, entry.form.url, entry.form.sha256);
    const folder = join(placement.dataDirectory, "mcp", ".add");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    bundle = join(folder, `${randomUUID()}.mcpb`);
    writeFileSync(bundle, bytes, { mode: 0o600 });
    concrete = { kind: "mcpb", path: bundle, args: entry.form.args };
  } else if (entry.form.kind === "url") {
    // A remote the listing gives no headers for is probed once: a 401 naming its
    // protected-resource metadata (RFC 9728 §5.1) means it signs in with OAuth, as `--oauth` says by hand.
    // A server that never answers delays the add by the probe's deadline only, then stays as listed.
    const probe: FetchLike = async (input, init) => await registry.fetch(input, { ...init, signal: AbortSignal.timeout(SIGN_IN_PROBE_MS) });
    oauth = entry.form.headers.length === 0 && (await challengedMetadataUrl(entry.form.url, probe)) !== undefined;
    concrete = { kind: "url", url: entry.form.url, headers: entry.form.headers, lan: false, ...(oauth ? { oauth: true } : {}) };
  } else {
    concrete = { kind: entry.form.kind, spec: entry.form.spec, args: entry.form.args };
  }
  const version = EXACT_VERSION.test(server.version) && entry.form.kind !== "mcpb" ? { version: server.version } : {};
  try {
    const written = await writeMcpPluginDirectory(
      {
        ...version,
        ...options,
        form: concrete,
        env: [...entry.env, ...(options.env ?? [])],
        credentials: [...entry.credentials, ...(options.credentials ?? [])],
        ...(options.description !== undefined || shown.description === "" ? {} : { description: shown.description }),
      },
      placement,
    );
    const signIn = oauth ? ["it answered that it signs in with OAuth: connect it once it is reviewed (`tavi apps connect`)"] : [];
    return {
      ...written,
      notes: [
        `from the MCP Registry: ${shown.name} ${shown.version} (${form.option}) — the listing is its publisher's word, not a reason to trust it`,
        ...entry.notes,
        ...signIn,
        ...written.notes,
      ],
    };
  } finally {
    if (bundle !== undefined) rmSync(bundle, { force: true });
  }
}

/** A bundle's name as a package name: lower case, other characters as `-`. */
function bundlePackageName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[-.]+/, "")
      .slice(0, 214) || "bundle"
  );
}

/** The manifest with its folder grants checked against this owner's home and data directory. */
function checkedManifest(manifest: PluginManifest, placement: McpAddPlacement): PluginManifest {
  const problems =
    manifest.mcp === undefined
      ? []
      : mcpFilesystemProblems(manifest.mcp, { home: placement.home ?? homedir(), dataDirectory: placement.dataDirectory });
  if (problems.length > 0) throw new TaviError("INVALID_INPUT", `the server cannot be added: ${problems.join("; ")}`);
  return manifest;
}
