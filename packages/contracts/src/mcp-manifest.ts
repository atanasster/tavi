import { z } from "zod";

/**
 * An MCP server as a plugin: a manifest with an
 * `mcp` block (ABI `tavi.mcp/1`) and no `entry`, so it runs no code in the
 * owner. The block is the launch spec; the content hash covers it, so a
 * changed launch spec is a new version and a new review. The sandbox state is
 * deliberately not here: the operator chooses it and it is recorded with the
 * version, so a manifest cannot ask to run unsandboxed.
 */

export const MCP_ABI = "tavi.mcp/1";

/** Reviewed server templates: `homeassistant`, `google-maps`, `todoist`. Google Calendar is a Google account's own (its calendar opt-in). */
export const MCP_PRESET_IDS = [
  "homeassistant",
  "google-maps",
  "todoist",
  "todoist-token",
  "linear",
  "notion",
  "sentry",
  "stripe",
  "figma",
] as const;
export type McpPresetId = (typeof MCP_PRESET_IDS)[number];

/** The operator's name for a server: `[a-z][a-z0-9]*`, at most 19 characters, never taken from the server. */
export const MCP_SLUG_PATTERN = /^[a-z][a-z0-9]{0,18}$/;
export const McpSlugSchema = z
  .string()
  .regex(MCP_SLUG_PATTERN, "a server name is lowercase letters and digits, starting with a letter, at most 19 characters");

/** The plugin id namespace reserved for MCP servers. */
export const MCP_PLUGIN_PREFIX = "mcp.";

/** `mcp.<slug>` → `<slug>`; `undefined` for any other id. */
export function mcpSlugOf(pluginId: string): string | undefined {
  if (!pluginId.startsWith(MCP_PLUGIN_PREFIX)) return undefined;
  const slug = pluginId.slice(MCP_PLUGIN_PREFIX.length);
  return MCP_SLUG_PATTERN.test(slug) ? slug : undefined;
}

/** The provenance formats of an MCP server's plugin. */
export const MCP_PROVENANCE_FORMATS = ["mcp-remote", "mcp-npm", "mcp-pypi", "mcp-dir", "mcp-command", "mcp-mcpb"] as const;

export const MCP_MESSAGE_BYTES = { min: 64 * 1024, max: 4 * 1024 * 1024, default: 1024 * 1024 } as const;
export const MCP_CONCURRENCY = { min: 1, max: 16, default: 4 } as const;

const settingName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .max(64);

/** A value from a literal or from one of the plugin's settings. */
export const McpValueSourceSchema = z.union([z.strictObject({ value: z.string().max(4096) }), z.strictObject({ setting: settingName })]);
export type McpValueSource = z.infer<typeof McpValueSourceSchema>;

/** A header's value: a literal, or a setting with an optional prefix (`Bearer `). */
export const McpHeaderSourceSchema = z.union([
  z.strictObject({ value: z.string().max(4096) }),
  z.strictObject({ setting: settingName, prefix: z.string().max(64).optional() }),
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/**
 * Variables a server is never given: they change what the runtime loads or
 * where it looks. Matched in any case, as Windows reads them (`Path` is `PATH` there).
 */
export function refusedEnvName(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (upper === "NODE_OPTIONS") return `${name} would change what node loads`;
  if (/^LD_/.test(upper)) return `${name} would change what the dynamic linker loads`;
  if (/^DYLD_/.test(upper)) return `${name} would change what the dynamic linker loads`;
  if (upper === "PYTHONPATH" || upper === "PYTHONSTARTUP" || upper === "PYTHONHOME") return `${name} would change what python loads`;
  if (upper === "PATH") return `${name} is built by Tavi from the runtime in use`;
  if (/^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/.test(upper)) return `${name} would change where the sandbox's proxy connects`;
  if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].includes(upper)) return `${name} would change which Windows programs run`;
  return undefined;
}

/** A name that looks like it holds a secret: only a credential setting may feed it. */
export function secretLookingName(name: string): boolean {
  return /(token|secret|password|passwd|api[-_]?key|apikey|private[-_]?key|credential|auth|cookie|session)/i.test(name);
}

/** A program's name as a rule reads it: its last path segment (either separator), lower-cased, without a Windows program extension. */
const programName = (program: string | undefined): string =>
  (program ?? "")
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "") ?? "";

/** The program an argv runs, past a leading `env` with its options and `VAR=value` assignments. */
export function programArgv(argv: readonly string[]): readonly string[] {
  if (programName(argv[0]) !== "env") return argv;
  let index = 1;
  while (index < argv.length && ((argv[index] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? ""))) index += 1;
  return argv.slice(index);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "cmd", "powershell", "pwsh"]);

/** A shell as the program: it runs a string, which the argv rule exists to prevent. */
export function shellCommand(argv: readonly string[]): string | undefined {
  const program = programName(programArgv(argv)[0]);
  return SHELLS.has(program) ? `${program} runs a string; give the server's own argv` : undefined;
}

/** Launchers that download and run code at start: a pinned install replaces each. */
export function downloaderCommand(given: readonly string[]): string | undefined {
  const argv = programArgv(given);
  const program = programName(argv[0]);
  if (program === "npx" || program === "bunx" || program === "uvx")
    return `${program} downloads code at every start; install the package pinned instead (--npm or --pypi)`;
  if (program === "pnpm" && argv[1] === "dlx") return "pnpm dlx downloads code at every start; install the package pinned instead (--npm)";
  if (program === "yarn" && argv[1] === "dlx") return "yarn dlx downloads code at every start; install the package pinned instead (--npm)";
  if (program === "npm" && argv[1] === "exec") return "npm exec downloads code at every start; install the package pinned instead (--npm)";
  if (program === "docker" || program === "podman")
    return `${program} runs containers, which are not supported (docker.sock is root-equivalent)`;
  return undefined;
}

const relativeInside = (path: string): boolean =>
  path !== "" && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\");
/** A Windows drive path (`C:\x` or `C:/x`), its drive captured. */
const WINDOWS_DRIVE_PATH = /^([A-Za-z]:)[\\/]/;

const plainSegments = (rest: string): boolean =>
  rest
    .replace(/\/$/, "")
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * An absolute path in its plain spelling: no `.`, `..` or empty segment (one
 * trailing separator allowed). On Windows a drive path (`C:\Tools\x.exe`), with
 * either separator; never a network path (`\\server\share`).
 */
const absolute = (path: string): boolean => {
  if (path === "/") return true;
  if (path.startsWith("/")) return plainSegments(path.slice(1));
  const drive = WINDOWS_DRIVE_PATH.exec(path);
  return drive !== null && (path.length === 3 || plainSegments(path.slice(3).replace(/\\/g, "/")));
};

export const McpPackageSchema = z.strictObject({
  registry: z.enum(["npm", "pypi"]),
  name: z.string().min(1).max(214),
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9][0-9A-Za-z.+-]*$/, "an exact version"),
  integrity: z.string().max(256).optional(),
});

export const McpBlockSchema = z
  .strictObject({
    abi: z.literal(MCP_ABI),
    transport: z.enum(["stdio", "http"]),
    /** http: the server's address. */
    url: McpValueSourceSchema.optional(),
    /** http: headers sent on every request. */
    headers: z.record(z.string().regex(HEADER_NAME), McpHeaderSourceSchema).optional(),
    /** stdio: the package fetched at install (`${package}` resolves to its directory). */
    package: McpPackageSchema.optional(),
    /** stdio: an argv array, never a shell string. */
    command: z
      .array(z.string().min(1).max(4096), {
        error: (issue) => (typeof issue.input === "string" ? "command is an argv array, never a shell string" : undefined),
      })
      .min(1)
      .max(64)
      .optional(),
    /** stdio: the command is a system binary outside the plugin; its path and hash are recorded at approval. */
    external: z.boolean().optional(),
    /**
     * stdio: the uv-managed Python interpreter `python` means (`--pypi`),
     * pinned at install by its resolved path and
     * SHA-256, and checked before every start.
     */
    interpreter: z
      .strictObject({
        path: z.string().min(2).max(1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        version: z.string().max(32),
      })
      .optional(),
    env: z.record(z.string().regex(ENV_NAME), McpValueSourceSchema).optional(),
    network: z
      .strictObject({
        /** stdio: the domains the server may reach, through its own proxy. */
        domains: z
          .array(
            z
              .string()
              .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a domain, such as api.example.com")
              .max(253),
          )
          .max(64)
          .optional(),
        /** http: a private, loopback or link-local address, and plain http only there. */
        lan: z.boolean().optional(),
      })
      .optional(),
    filesystem: z
      .strictObject({
        read: z.array(z.string().max(1024)).max(32).default([]),
        write: z.array(z.string().max(1024)).max(32).default([]),
      })
      .optional(),
    auth: z.enum(["none", "headers", "oauth"]).default("none"),
    exposure: z.enum(["auto", "always", "search"]).default("auto"),
    /** The preset this manifest was written from: its floors join each tool's suggestion at approval. */
    preset: z.enum(MCP_PRESET_IDS).optional(),
    maxMessageBytes: z.number().int().min(MCP_MESSAGE_BYTES.min).max(MCP_MESSAGE_BYTES.max).default(MCP_MESSAGE_BYTES.default),
    concurrency: z.number().int().min(MCP_CONCURRENCY.min).max(MCP_CONCURRENCY.max).default(MCP_CONCURRENCY.default),
  })
  .superRefine((block, context) => {
    const issue = (message: string, path: readonly (string | number)[] = []): void =>
      context.addIssue({ code: "custom", path: [...path], message });
    if (block.transport === "http") {
      if (block.url === undefined) issue("an http server needs a url", ["url"]);
      for (const field of ["command", "package", "env", "filesystem", "external", "interpreter"] as const) {
        if (block[field] !== undefined) issue(`${field} applies to a stdio server only`, [field]);
      }
      if (block.network?.domains !== undefined)
        issue("network.domains applies to a stdio server only; an http server reaches its url", ["network", "domains"]);
      if (block.url !== undefined && "value" in block.url) {
        // No URL class in contracts (globals.d.ts): the scheme, authority and credentials read by pattern.
        const url = block.url.value;
        if (!/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(url)) issue("url is not a valid http(s) address", ["url"]);
        else if (!/^https:/i.test(url) && block.network?.lan !== true)
          issue("url must be https; plain http only with network.lan", ["url"]);
        if (/^[a-z]+:\/\/[^/?#]*@/i.test(url)) issue("url must not carry credentials; use a header from a credential setting", ["url"]);
      }
    } else {
      if (block.command === undefined) issue("a stdio server needs a command", ["command"]);
      for (const field of ["url", "headers"] as const) {
        if (block[field] !== undefined) issue(`${field} applies to an http server only`, [field]);
      }
      if (block.network?.lan !== undefined) issue("network.lan applies to an http server only", ["network", "lan"]);
      if (block.auth === "headers") issue("auth: headers applies to an http server only", ["auth"]);
    }
    const argv = block.command ?? [];
    const downloader = downloaderCommand(argv) ?? shellCommand(argv);
    if (downloader !== undefined) issue(downloader, ["command", 0]);
    const program = argv[0];
    if (program !== undefined && downloader === undefined) {
      if (block.external === true) {
        if (!absolute(program)) issue("an external command is an absolute path", ["command", 0]);
      } else if (program !== "node" && program !== "python") {
        const inside = program.startsWith("${package}/") ? program.slice("${package}/".length) : program;
        if (!relativeInside(inside))
          issue("command[0] is node, python, or a path inside the plugin directory; a system binary needs external: true", ["command", 0]);
      }
    }
    if (block.interpreter !== undefined && !absolute(block.interpreter.path))
      issue("interpreter.path is an absolute path", ["interpreter", "path"]);
    if (program === "python" && block.external !== true && block.interpreter === undefined)
      issue("a python command needs its pinned interpreter (add it with --pypi, or --dir with uv)", ["interpreter"]);
    if (block.interpreter !== undefined && (program !== "python" || block.external === true))
      issue("interpreter applies to a python command only", ["interpreter"]);
    if (argv.some((arg) => arg.includes("${package}"))) {
      for (const [index, arg] of argv.entries()) {
        if (arg.includes("${package}") && !(arg.startsWith("${package}/") && relativeInside(arg.slice("${package}/".length))))
          issue("${package} is used as a path prefix inside the package only", ["command", index]);
      }
    }
    for (const name of Object.keys(block.env ?? {})) {
      const refused = refusedEnvName(name);
      if (refused !== undefined) issue(refused, ["env", name]);
    }
    for (const [kind, paths] of Object.entries({ read: block.filesystem?.read ?? [], write: block.filesystem?.write ?? [] })) {
      for (const [index, path] of paths.entries()) {
        if (!absolute(path)) issue("a filesystem path is absolute, with no ..", ["filesystem", kind, index]);
      }
    }
  });
export type McpBlock = z.infer<typeof McpBlockSchema>;

/**
 * What the `mcp` block asks of the manifest's settings (`env` and
 * `headers`): every setting it names exists; one fed to a header, or to a
 * secret-looking variable, is a credential; a literal never feeds a
 * secret-looking variable or header; the url setting is a string.
 */
export function mcpSettingProblems(block: McpBlock, config: Readonly<Record<string, { readonly type: string }>>): string[] {
  const problems: string[] = [];
  const named = (setting: string, where: string): { readonly type: string } | undefined => {
    const field = config[setting];
    if (field === undefined) problems.push(`${where} names setting ${setting}, which the manifest does not declare`);
    return field;
  };
  if (block.url !== undefined && "setting" in block.url) {
    const field = named(block.url.setting, "url");
    if (field !== undefined && field.type !== "string") problems.push(`url's setting ${block.url.setting} must be a string setting`);
  }
  for (const [name, source] of Object.entries(block.headers ?? {})) {
    if ("setting" in source) {
      const field = named(source.setting, `header ${name}`);
      if (field !== undefined && field.type !== "credential")
        problems.push(`header ${name} is fed by ${source.setting}, which must be a credential setting`);
    } else if (secretLookingName(name)) problems.push(`header ${name} looks secret: feed it from a credential setting, not a literal`);
  }
  for (const [name, source] of Object.entries(block.env ?? {})) {
    if ("setting" in source) {
      const field = named(source.setting, `env ${name}`);
      if (field !== undefined && secretLookingName(name) && field.type !== "credential")
        problems.push(`env ${name} looks secret: its setting ${source.setting} must be a credential setting`);
    } else if (secretLookingName(name)) problems.push(`env ${name} looks secret: feed it from a credential setting, not a literal`);
  }
  return problems;
}

/** The block as one line per fact, for `tavi plugins show` and the review: the exact command or url first. */
export function mcpBlockLines(block: McpBlock): string[] {
  const source = (value: McpValueSource): string => ("value" in value ? value.value : `<setting ${value.setting}>`);
  const lines: string[] = [];
  if (block.transport === "http") {
    lines.push(`url ${block.url === undefined ? "?" : source(block.url)}`);
    for (const [name, value] of Object.entries(block.headers ?? {}))
      lines.push(`header ${name}: ${"value" in value ? value.value : `${value.prefix ?? ""}<credential ${value.setting}>`}`);
    if (block.network?.lan === true) lines.push("network: may use a private, loopback or link-local address (lan)");
  } else {
    lines.push(`command ${JSON.stringify(block.command ?? [])}${block.external === true ? " (external binary)" : ""}`);
    if (block.package !== undefined) lines.push(`package ${block.package.registry}:${block.package.name}@${block.package.version}`);
    if (block.interpreter !== undefined)
      lines.push(`python ${block.interpreter.version} at ${block.interpreter.path} (sha256 ${block.interpreter.sha256.slice(0, 12)}…)`);
    for (const [name, value] of Object.entries(block.env ?? {})) lines.push(`env ${name}=${source(value)}`);
    lines.push(
      `network: ${block.network?.domains === undefined || block.network.domains.length === 0 ? "none" : block.network.domains.join(", ")}`,
    );
    if ((block.filesystem?.read.length ?? 0) > 0) lines.push(`reads ${block.filesystem?.read.join(", ")}`);
    if ((block.filesystem?.write.length ?? 0) > 0) lines.push(`writes ${block.filesystem?.write.join(", ")}`);
  }
  lines.push(
    `auth ${block.auth}, exposure ${block.exposure}, messages up to ${String(block.maxMessageBytes)} bytes, ${String(block.concurrency)} calls at once`,
  );
  return lines;
}

/** Directories that hold credentials of other tools: never granted to a server (`filesystem`). */
export const CREDENTIAL_HOMES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
] as const;

/** Why a filesystem grant is refused: `$HOME` itself, under Tavi's data directory, or under a credential home. */
export function mcpFilesystemProblems(block: McpBlock, where: { readonly home: string; readonly dataDirectory: string }): string[] {
  const problems: string[] = [];
  // Compared case-blind: the default macOS volume is case-insensitive, so ~/.SSH is ~/.ssh.
  // And with `/` between folders, so a Windows path is compared as a POSIX one is.
  const trim = (path: string): string => {
    const slashed = path.replace(/\\/g, "/");
    return (slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed).toLowerCase();
  };
  const home = trim(where.home);
  const data = trim(where.dataDirectory);
  const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
  for (const given of [...(block.filesystem?.read ?? []), ...(block.filesystem?.write ?? [])]) {
    const problem = folderGrantProblem(given, { home, data, trim, under });
    if (problem !== undefined) problems.push(problem);
  }
  // A pinned interpreter's install is read in the sandbox too: the same rule, and never a folder holding $HOME.
  if (block.interpreter !== undefined) {
    const prefix = mcpInterpreterPrefix(block.interpreter.path);
    const problem =
      prefix.split("/").filter((segment) => segment !== "" && !/^[A-Za-z]:$/.test(segment)).length < 2 || under(home, trim(prefix))
        ? `the interpreter's install ${prefix} is too wide a grant`
        : folderGrantProblem(prefix, { home, data, trim, under });
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

/**
 * The install an interpreter lives in (`<prefix>/bin/python3.12` → `<prefix>`;
 * on Windows `<prefix>\python.exe` → `<prefix>`, with no `bin`): what its sandbox reads.
 */
export function mcpInterpreterPrefix(path: string): string {
  const drive = WINDOWS_DRIVE_PATH.exec(path)?.[1];
  if (drive !== undefined) {
    const segments = path.slice(3).split(/[\\/]/).filter(Boolean);
    return `${drive}/${segments.slice(0, Math.max(0, segments.length - 1)).join("/")}`;
  }
  const segments = path.split("/").filter(Boolean);
  return `/${segments.slice(0, Math.max(0, segments.length - 2)).join("/")}`;
}

function folderGrantProblem(
  given: string,
  where: {
    readonly home: string;
    readonly data: string;
    readonly trim: (path: string) => string;
    readonly under: (path: string, root: string) => boolean;
  },
): string | undefined {
  const path = where.trim(given);
  const { home, data, under } = where;
  if (path === "/" || path === home) return `${given} is too wide a grant: name a folder inside it`;
  if (under(path, data) || under(data, path)) return `${given} overlaps Tavi's data directory`;
  if (CREDENTIAL_HOMES.some((name) => under(path, `${home}/${name.toLowerCase()}`) || under(`${home}/${name.toLowerCase()}`, path)))
    return `${given} holds or contains another tool's credentials`;
  return undefined;
}

/** Why a folder may not be copied in as a server's files (`tavi mcp add --dir`): the same rule as a grant. */
export function mcpFolderProblem(folder: string, where: { readonly home: string; readonly dataDirectory: string }): string | undefined {
  const block = McpBlockSchema.safeParse({
    abi: MCP_ABI,
    transport: "stdio",
    command: ["node", "x"],
    filesystem: { read: [folder], write: [] },
  });
  if (!block.success) return `${folder} is not an absolute folder path`;
  return mcpFilesystemProblems(block.data, where)[0];
}

/**
 * Where `${package}` points inside the plugin directory: `package/` for a
 * fetched npm or PyPI package, `server/` for a copied
 * directory or a bundle; `undefined` when the manifest has neither.
 */
export function mcpPackageDirectory(manifest: {
  readonly provenance: { readonly format: string };
  readonly mcp?: McpBlock | undefined;
}): string | undefined {
  if (manifest.mcp?.package !== undefined) return "package";
  if (manifest.provenance.format === "mcp-dir" || manifest.provenance.format === "mcp-mcpb") return "server";
  return undefined;
}

/** Tree limits for an MCP server fetched from a package registry or a bundle. */
export const MCP_PACKAGE_BOUNDS = { maxFiles: 20_000, maxDirectories: 5_000, maxDepth: 64, maxBytes: 300 * 1024 * 1024 } as const;
/** Tree limits for any other plugin directory, an MCP server's included (`--dir`, `--url`, `--command`). */
export const MCP_DIRECTORY_BOUNDS = { maxFiles: 500, maxDirectories: 500, maxDepth: 32, maxBytes: 20 * 1024 * 1024 } as const;

/** The bounds a plugin's tree is read under, by its provenance format. */
export function mcpTreeBounds(format: string): {
  readonly maxFiles: number;
  readonly maxDirectories: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
} {
  return format === "mcp-npm" || format === "mcp-pypi" || format === "mcp-mcpb" ? MCP_PACKAGE_BOUNDS : MCP_DIRECTORY_BOUNDS;
}
