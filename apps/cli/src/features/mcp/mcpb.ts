import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";

import { MCP_PACKAGE_BOUNDS, TaviError, refusedEnvName, secretLookingName, type McpBlock, type PluginConfigField } from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { z } from "zod";

import { serverLine } from "./results.js";

/**
 * `.mcpb` bundles: a zip with a `manifest.json` at
 * its root, read here without running anything. Its files are copied with
 * the server (`${package}` is the bundle's root); its `server.mcp_config`
 * becomes the server's command, and its `user_config` the plugin's settings,
 * a sensitive field a credential. A signature appended to the bundle is
 * shown, never checked or trusted: approval is the trust decision.
 */

/** The marks that open and close a signature block appended after the zip (MCPB, and DXT before it). */
const SIGNATURES = [
  { scheme: "MCPB_SIG_V1", end: "MCPB_SIG_END" },
  { scheme: "DXT_SIG_V1", end: "DXT_SIG_END" },
] as const;

/** One file of a bundle: its path inside the bundle, its bytes, and whether it is executable. */
export interface McpbFile {
  readonly path: string;
  readonly data: Buffer;
  readonly executable: boolean;
}

/** A bundle as read: its files, the zip's sha512 (SRI), and the signature block it carries, if any. */
export interface McpbArchive {
  readonly files: readonly McpbFile[];
  readonly integrity: string;
  readonly signature?: { readonly scheme: string; readonly bytes: number };
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The most an end-of-central-directory record can sit from the end: its 22 bytes and a 65,535-byte comment. */
const EOCD_SEARCH = 22 + 0xffff;

/** The zip without a signature block appended to it, and that block's scheme and size. */
export function withoutSignature(bundle: Buffer): {
  readonly zip: Buffer;
  readonly signature?: { readonly scheme: string; readonly bytes: number };
} {
  for (const { scheme, end } of SIGNATURES) {
    if (!bundle.subarray(bundle.length - end.length).equals(Buffer.from(end, "latin1"))) continue;
    const start = bundle.lastIndexOf(Buffer.from(scheme, "latin1"));
    if (start < 0) throw new TaviError("INVALID_INPUT", `the bundle ends with ${end} but carries no ${scheme} block`);
    return { zip: bundle.subarray(0, start), signature: { scheme, bytes: bundle.length - start } };
  }
  return { zip: bundle };
}

/** A path inside the bundle: relative, `/`-separated, with no `..`, drive or backslash; undefined when it is not one. */
function safePath(name: string): string | undefined {
  if (name === "" || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return undefined;
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

/**
 * The zip's files, read strictly: stored or deflated entries
 * only, no encryption, no symbolic links, no path outside the bundle, no name
 * twice (in any case), each entry's size and CRC as its header says, and the
 * package limits on files, folders, depth and bytes. macOS metadata
 * (`__MACOSX/`) is skipped.
 */
export function unzipBundle(
  zip: Buffer,
  bounds: {
    readonly maxFiles: number;
    readonly maxDirectories: number;
    readonly maxDepth: number;
    readonly maxBytes: number;
  } = MCP_PACKAGE_BOUNDS,
): readonly McpbFile[] {
  const refuse = (why: string): never => {
    throw new TaviError("INVALID_INPUT", `the bundle is not a zip Tavi reads: ${why}`);
  };
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - EOCD_SEARCH); at -= 1) {
    if (zip.readUInt32LE(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) refuse("no end of central directory");
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) refuse("it spans several disks");
  const count = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) refuse("it is a zip64 archive");
  const files: McpbFile[] = [];
  // Names as a case-insensitive, normalising file system sees them: two that differ only in case or Unicode form are one.
  const key = (name: string): string => name.normalize("NFC").toLowerCase();
  const seen = new Set<string>();
  const directories = new Set<string>();
  let total = 0;
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) refuse("its central directory is damaged");
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const raw = zip.subarray(at + 46, at + 46 + nameLength).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;
    if (raw.startsWith("__MACOSX/")) continue;
    const path = safePath(raw);
    if (path === undefined) refuse(`${JSON.stringify(raw.slice(0, 200))} is not a path inside the bundle`);
    const name = path as string;
    if ((flags & 0x1) !== 0) refuse(`${name} is encrypted`);
    // A Unix entry's mode: a symbolic link could point anywhere once copied.
    if (madeBy === 3 && (mode & 0o170000) === 0o120000) refuse(`${name} is a symbolic link`);
    const depth = name.split("/").length;
    if (depth > bounds.maxDepth) refuse(`${name} is more than ${String(bounds.maxDepth)} folders deep`);
    for (let cut = name.indexOf("/"); cut > 0; cut = name.indexOf("/", cut + 1)) directories.add(key(name.slice(0, cut)));
    if (raw.endsWith("/")) {
      directories.add(key(name));
      continue;
    }
    if (seen.has(key(name))) refuse(`${name} is in it twice`);
    seen.add(key(name));
    if (method !== 0 && method !== 8)
      refuse(`${name} is compressed with method ${String(method)}; only stored and deflated entries are read`);
    total += size;
    if (files.length + 1 > bounds.maxFiles) refuse(`it holds more than ${String(bounds.maxFiles)} files`);
    if (total > bounds.maxBytes) refuse(`it unpacks to more than ${String(Math.round(bounds.maxBytes / 1024 / 1024))} MB`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) refuse(`${name}'s entry is damaged`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressed > zip.length) refuse(`${name} runs past the end of the bundle`);
    const packed = zip.subarray(start, start + compressed);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
    } catch {
      return refuse(`${name} does not inflate to its stated ${String(size)} bytes`);
    }
    if (data.length !== size || crc32(data) !== crc) refuse(`${name} does not match its checksum`);
    files.push({ path: name, data, executable: madeBy === 3 && (mode & 0o111) !== 0 });
  }
  if (directories.size > bounds.maxDirectories) refuse(`it holds more than ${String(bounds.maxDirectories)} folders`);
  // A name that is both a file and a folder (`a` beside `a/b`) cannot be unpacked.
  const both = files.find((file) => directories.has(key(file.path)));
  if (both !== undefined) refuse(`${both.path} is both a file and a folder`);
  return files;
}

/** A bundle read from disk: at most the package limit in size, its signature block set aside. */
export function readMcpbFile(path: string): McpbArchive {
  if (!statSync(path).isFile()) throw new TaviError("NOT_FOUND", `no bundle at ${path}`);
  if (statSync(path).size > MCP_PACKAGE_BOUNDS.maxBytes)
    throw new TaviError("INVALID_INPUT", `the bundle is larger than ${String(MCP_PACKAGE_BOUNDS.maxBytes / 1024 / 1024)} MB`);
  const bundle = readFileSync(path);
  const { zip, signature } = withoutSignature(bundle);
  return {
    files: unzipBundle(zip),
    integrity: `sha512-${createHash("sha512").update(bundle).digest("base64")}`,
    ...(signature === undefined ? {} : { signature }),
  };
}

const McpConfigSchema = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).optional(),
  env: z.record(z.string(), z.string().max(4096)).optional(),
});

const UserConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "directory", "file"]),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  multiple: z.boolean().optional(),
  default: z.unknown().optional(),
});

/** The parts of a bundle's `manifest.json` Tavi reads (MCPB manifest 0.1–0.3, and DXT's before it). */
const McpbManifestSchema = z.object({
  manifest_version: z.string().max(16).optional(),
  dxt_version: z.string().max(16).optional(),
  name: z.string().min(1).max(214),
  display_name: z.string().max(200).optional(),
  version: z.string().min(1).max(64),
  description: z.string().max(2000).optional(),
  license: z.string().max(128).optional(),
  server: z.object({
    type: z.string().max(32),
    entry_point: z.string().max(4096).optional(),
    mcp_config: McpConfigSchema.extend({ platform_overrides: z.record(z.string(), McpConfigSchema.partial()).optional() }),
  }),
  user_config: z.record(z.string(), UserConfigFieldSchema).optional(),
  compatibility: z
    .object({ platforms: z.array(z.string()).optional() })
    .loose()
    .optional(),
});
export type McpbManifest = z.infer<typeof McpbManifestSchema>;

/** A bundle's manifest, from its root `manifest.json`. */
export function bundleManifest(files: readonly McpbFile[]): McpbManifest {
  const file = files.find((entry) => entry.path === "manifest.json");
  if (file === undefined) throw new TaviError("INVALID_INPUT", "the bundle has no manifest.json at its root");
  let json: unknown;
  try {
    json = JSON.parse(file.data.toString("utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", "the bundle's manifest.json is not JSON");
  }
  const parsed = McpbManifestSchema.safeParse(json);
  if (!parsed.success)
    throw new TaviError(
      "INVALID_INPUT",
      `the bundle's manifest.json cannot be read: ${zodIssues(parsed.error, "manifest").slice(0, 5).join("; ")}`,
    );
  return parsed.data;
}

/**
 * What `python -c` runs for a bundled Python server: its bundled folders
 * (what it set `PYTHONPATH` to, which a server may not set) first on the
 * path, then its script — or its `-m` module — as `__main__`, with its argv.
 * argv: the number of folders, the folders, the script or module, its args.
 */
export const MCPB_PYTHON_BOOTSTRAP =
  "import sys,os,runpy;n=int(sys.argv[1]);p=sys.argv[2:2+n];s=sys.argv[2+n];m=s.startswith('-m:');sys.argv=[s]+sys.argv[3+n:];sys.path[:0]=p if m else [os.path.dirname(s)]+p;runpy.run_module(s[3:],run_name='__main__',alter_sys=True) if m else runpy.run_path(s,run_name='__main__')";

/** A bundle's server as an `mcp` block's parts: its command, environment and settings, and what the review should say. */
export interface McpbServer {
  readonly runtime: "node" | "python" | "binary";
  readonly command: readonly string[];
  readonly env: NonNullable<McpBlock["env"]>;
  readonly config: Readonly<Record<string, PluginConfigField>>;
  readonly notes: readonly string[];
}

const VARIABLE = /\$\{([^}]*)\}/g;

/** A publisher's words as a person is shown them: cleaned, on one line, cut. */
const shown = serverLine;

/**
 * The bundle's `mcp_config` (with this platform's override) as Tavi runs it:
 * `${__dirname}` is `${package}`; `${user_config.<name>}` is that setting,
 * and only as a whole environment value — a setting in the arguments is
 * refused, as is a folder outside the bundle (`${HOME}`, `${DOCUMENTS}` …),
 * which the sandbox would not let it reach. A Node server runs on Tavi's
 * own Node, a Python one on the pinned uv interpreter with its bundled
 * folders through the bootstrap, a binary from inside the bundle. A `uv`
 * server, which installs its dependencies when it starts, is refused.
 */
export function mcpbServer(manifest: McpbManifest, files: readonly McpbFile[], platform: NodeJS.Platform = process.platform): McpbServer {
  const refuse = (why: string): never => {
    throw new TaviError("UNSUPPORTED", `the bundle ${shown(manifest.name, 120)} cannot be added: ${why}`);
  };
  const platforms = manifest.compatibility?.platforms;
  if (platforms !== undefined && platforms.length > 0 && !platforms.includes(platform))
    refuse(`it runs on ${platforms.join(", ")}, not ${platform}`);
  const override = manifest.server.mcp_config.platform_overrides?.[platform] ?? {};
  const base = manifest.server.mcp_config;
  const config = {
    command: override.command ?? base.command,
    args: override.args ?? base.args ?? [],
    env: { ...base.env, ...override.env },
  };
  const settings = manifest.user_config ?? {};
  const has = (path: string): McpbFile | undefined => files.find((file) => file.path === path);

  /** A string with the bundle's variables replaced: `${__dirname}` → `${package}`, a separator → `/`. */
  const expand = (text: string, where: string): string =>
    text.replace(VARIABLE, (_whole, name: string) => {
      if (name === "__dirname") return "${package}";
      if (name === "/" || name === "pathSeparator") return "/";
      if (name.startsWith("user_config."))
        return refuse(
          `${where} passes the setting ${name.slice("user_config.".length)} inside a value; Tavi passes a setting only as a whole environment variable`,
        );
      return refuse(
        `${where} names \${${name}}, a folder outside the bundle, which its sandbox does not reach (grant a folder with --read or --write instead)`,
      );
    });
  /** A path inside the bundle, as the command names it. */
  const inside = (arg: string, where: string): string => {
    const path = expand(arg, where);
    if (!path.startsWith("${package}/")) refuse(`${where} (${arg}) is not a file inside the bundle`);
    const file = has(path.slice("${package}/".length).replace(/\/+/g, "/"));
    if (file === undefined) refuse(`${where} names ${path.slice("${package}/".length)}, which is not in the bundle`);
    return path;
  };

  const env: Record<string, NonNullable<McpBlock["env"]>[string]> = {};
  let pythonPaths: string[] = [];
  for (const [name, value] of Object.entries(config.env)) {
    const whole = /^\$\{user_config\.([a-zA-Z][a-zA-Z0-9_]*)\}$/.exec(value);
    if (whole !== null) {
      const setting = whole[1] as string;
      if (settings[setting] === undefined) refuse(`env ${name} names the setting ${setting}, which its user_config does not declare`);
      env[name] = { setting };
      continue;
    }
    if (name === "PYTHONPATH") {
      pythonPaths = expand(value, `env ${name}`)
        .split(/[:;]/)
        .filter((part) => part !== "")
        .map((part) => {
          if (!part.startsWith("${package}/") && part !== "${package}") refuse(`PYTHONPATH names ${part}, a folder outside the bundle`);
          return part === "${package}" ? "${package}/." : part;
        });
      continue;
    }
    const refused = refusedEnvName(name);
    if (refused !== undefined) refuse(`env ${name}: ${refused}`);
    const literal = expand(value, `env ${name}`);
    if (literal.includes("${package}")) refuse(`env ${name} names a path inside the bundle, which Tavi does not pass in a variable`);
    if (secretLookingName(name))
      refuse(`env ${name} looks secret but is a literal in the bundle; a secret is a sensitive user_config field`);
    env[name] = { value: literal };
  }

  const args = config.args;
  const type = manifest.server.type;
  const program = config.command;
  let runtime: McpbServer["runtime"];
  let command: string[];
  if (type === "uv" || program === "uv" || program === "uvx")
    return refuse("a uv bundle installs its dependencies when it starts; Tavi runs only what was reviewed");
  if (type === "node" || program === "node") {
    if (program !== "node") refuse(`a node bundle's command is node, not ${program}`);
    if (args.length === 0) refuse("its node command names no entry point");
    runtime = "node";
    command = [
      "node",
      ...args.map((arg, index) => (index === 0 ? inside(arg, "its entry point") : expand(arg, `argument ${String(index + 1)}`))),
    ];
  } else if (type === "python" || program === "python" || program === "python3") {
    if (program !== "python" && program !== "python3") refuse(`a python bundle's command is python, not ${program}`);
    runtime = "python";
    const module = args[0] === "-m" ? args[1] : undefined;
    if (args[0] === "-m" && (module === undefined || !/^[A-Za-z_][\w.]*$/.test(module))) refuse("its -m names no module");
    const target = module === undefined ? inside(args[0] ?? "", "its script") : `-m:${module}`;
    const rest = args.slice(module === undefined ? 1 : 2).map((arg, index) => expand(arg, `argument ${String(index + 2)}`));
    command = ["python", "-I", "-B", "-c", MCPB_PYTHON_BOOTSTRAP, String(pythonPaths.length), ...pythonPaths, target, ...rest];
  } else if (type === "binary") {
    runtime = "binary";
    const binary = inside(program, "its binary");
    if (!has(binary.slice("${package}/".length))?.executable)
      refuse(`its binary ${binary.slice("${package}/".length)} is not marked executable in the bundle`);
    command = [binary, ...args.map((arg, index) => expand(arg, `argument ${String(index + 1)}`))];
  } else {
    return refuse(`its server type ${JSON.stringify(type)} is not node, python or binary`);
  }
  if (pythonPaths.length > 0 && runtime !== "python") refuse("it sets PYTHONPATH, which only a python server reads");

  // A setting the environment is fed from is needed to start at all, whatever the bundle says: Tavi sets no default.
  const fed = new Set(Object.values(env).flatMap((source) => ("setting" in source ? [source.setting] : [])));
  const declared: Record<string, PluginConfigField> = {};
  const notes: string[] = [];
  for (const [name, field] of Object.entries(settings)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || name.length > 64)
      refuse(`its setting ${JSON.stringify(name)} is not a setting name Tavi takes`);
    const type = field.sensitive === true ? "credential" : field.type === "number" || field.type === "boolean" ? field.type : "string";
    const shownDefault =
      field.default === undefined || field.sensitive === true
        ? ""
        : ` (the bundle's default: ${JSON.stringify(field.default).slice(0, 100)})`;
    // The publisher's title and description, cleaned: a setting's description is shown to a person.
    declared[name] = {
      type,
      required: field.required === true || fed.has(name),
      description: shown(`${field.title ?? name}${field.description === undefined ? "" : `: ${field.description}`}${shownDefault}`, 500),
    };
    if (field.type === "directory" || field.type === "file")
      notes.push(`setting ${name} is a ${field.type}: the server reaches it only once it is granted (--read or --write)`);
    if (field.multiple === true) notes.push(`setting ${name} takes several values in the bundle; Tavi passes one`);
  }
  return { runtime, command, env, config: declared, notes };
}
