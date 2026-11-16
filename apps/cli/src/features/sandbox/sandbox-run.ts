import { realpathSync } from "node:fs";
import { z } from "zod";

import {
  CONTENT_LABEL_LIMITS,
  SANDBOX_REACHED_NETWORK_DETAIL,
  SANDBOX_REQUEST_DOMAINS_MAX,
  type SandboxPort,
  type SandboxRunResult,
  TOOL_LABEL_KEY,
  TOOL_UNTRUSTED_KEY,
  TaviError,
  dispatchSandboxedTool,
  expandSandboxDomains,
  isUntrusted,
  requestableSandboxDomain,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import { type ToolRegistry, hostAllowedWithPort } from "@tavi/runtime";

import { assessSandboxRun } from "../approvals/call-assessors.js";
import { currentHostMarks } from "../folders/fs-tools.js";
import { sandboxArgv, spacedProgram } from "./command-line.js";
import {
  changedSensitiveFiles,
  cwdFor,
  ensureOwnFolder,
  folderOf,
  holdsDownloads,
  hostFoldersOf,
  reachesHostFolder,
  sensitiveFilesNow,
} from "./sandbox-folders.js";
import { type SandboxBase, type SandboxToolOptions, credentialSecrets, environmentFor, policyFor, unique } from "./sandbox-policy.js";

/** The domains granted to a workspace's shell, as written (`@registries`): the owner's and the workspace's. */
async function grantedDomainsFor(options: SandboxToolOptions, workspaceId: string): Promise<readonly string[]> {
  return unique([...(options.domains ?? []), ...((await options.workspaceDomains?.(workspaceId)) ?? [])]);
}

/** Whether a grant covers `domain` (`host` or `host:port`), as a grant is matched: a `*.domain` covers its subdomains. */
function isGrantedHost(domain: string, granted: readonly string[]): boolean {
  try {
    return hostAllowedWithPort(new URL(`https://${domain}`), granted);
  } catch {
    return false;
  }
}

/** Why `requestDomains` is refused where the workspace's shell may not ask for a host. */
const NO_ASKING =
  "this workspace's shell reaches only the granted domains (sandbox.network is granted): run without requestDomains, or ask the person to grant them (tavi config set sandbox.domains)";

/** The most text `sandbox.run`'s `stdin` carries. */
const SANDBOX_STDIN_MAX_CHARS = 262_144;

const SandboxRunInputSchema = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).optional(),
  cwd: z.string().max(4096).optional(),
  stdin: z.string().max(SANDBOX_STDIN_MAX_CHARS).optional().describe("Text given to the program on standard input"),
  timeoutMs: z.number().int().min(1_000).optional().describe("How long the run may take, in ms, up to the operator's limit"),
  requestDomains: z
    .array(z.string().max(260))
    .max(SANDBOX_REQUEST_DOMAINS_MAX)
    .optional()
    .describe(
      "Hosts nobody granted that this run needs (pypi.org, api.example.com:443), when the workspace lets the shell ask; the person approves them on the call's card, for this run",
    ),
});

/** `sandbox.run`, with `base` the policy every call of this owner shares (`sandboxBase`). */
export function registerSandboxRun(registry: ToolRegistry, sandbox: SandboxPort, options: SandboxToolOptions, base: SandboxBase): void {
  registry.register({
    id: "sandbox.run",
    sink: "none",
    version: "1.0.0",
    description: `Run a program inside the sandboxed execution environment: \`command\` is the program (python3, ls), \`args\` its arguments (["-c", "print(1)"]). A whole command line in \`command\` is split for you, and one that needs a shell (pipes, redirects, &&, globs, variables) runs as \`/bin/sh -c '<line>'\` (\`ranAs\` says how it ran). \`stdin\` is text given to the program on standard input. A run stops after ${Math.round(base.resources.timeoutMs / 1000)} seconds, or \`timeoutMs\` up to ${Math.round(base.maxTimeoutMs / 1000)}, and keeps ${Math.round(base.resources.maxOutputBytes / 1024)} KiB of each of stdout and stderr, the first and last halves of a longer one, with how much was left out between them (\`truncated\` says when). \`HOME\` is a folder kept across turns, so caches and \`pip install --user\` persist. It runs in your working folder (\`cwd\` defaults to it, and a relative \`cwd\` or path resolves there) and may write only there and in folders attached read-write; the rest of the host is closed, and the network is off but for the domains the operator granted, reached through the run's own proxy (\`HTTPS_PROXY\` is set for you); \`networkRefused\` says when \`requestDomains\` may ask the person for more. For scratch files use \`mktemp -p "$TMPDIR"\` (a bare \`mktemp\` ignores \`$TMPDIR\`). When a run hits a limit the result says which and what to do next: \`timedOut\`, \`writeRefused\`, \`networkRefused\`, \`limits\` (processes or CPU), \`askedEveryTime\`. The shell cannot write a repository's .git/hooks or .git/config, shell profiles or .vscode/.idea settings anywhere, though \`git init\`/\`git clone\` into a subfolder of your own folder work (no git hook runs), nor package managers' config (.npmrc, .yarnrc.yml, …) in a host or attached folder (use fs.edit); a run that changes a file the host runs on purpose (package.json, a Makefile, CLAUDE.md) names it in \`hostRunsChanged\`; in a host or attached folder it cannot write any \`.git\` at all, so \`git commit\` fails there too. Filesystem/network access is the operator's policy; only a person widens it, call by call.`,
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    requiresSandbox: true,
    // The run's own timeout ends it first; this only answers a sandbox that never does.
    timeoutMs: base.maxTimeoutMs + 30_000,
    // Its output is untrusted only after a request got through, or while `downloads/` holds a file: then it names the sandbox.
    outputSource: "sandbox",
    inputSchema: SandboxRunInputSchema,
    assess: assessSandboxRun,
    // Hosts asked for where the workspace's shell may not ask are refused before anyone is asked: an approval could not make them work.
    checkSources: async (input, context) => {
      const parsed = SandboxRunInputSchema.safeParse(input);
      const requested = parsed.success ? (parsed.data.requestDomains ?? []) : [];
      if (requested.length === 0) return { statuses: [], contentHash: sha256Hex(JSON.stringify(["sandbox.run", null, requested])) };
      // No setting reads as the default, `granted`, as the handler reads it.
      const network = (await options.workspaceNetwork?.(context.workspaceId)) ?? "granted";
      if (network !== "ask") return { refused: NO_ASKING };
      // Hosts already granted need no asking: a card for them would only be a high-risk question about nothing.
      const granted = expandSandboxDomains(await grantedDomainsFor(options, context.workspaceId));
      if (requested.every((entry) => isGrantedHost(requestableSandboxDomain(entry) ?? entry, granted)))
        return { refused: `${requested.join(", ")} ${requested.length === 1 ? "is" : "are"} granted already: run without requestDomains` };
      // Nothing to refuse: the hash binds what was checked, as the gate needs a SHA-256 hex.
      return { statuses: [], contentHash: sha256Hex(JSON.stringify(["sandbox.run", network, requested])) };
    },
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "sandbox.run was cancelled");
      const parsed = SandboxRunInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "sandbox.run received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const spaced = spacedProgram(parsed.data.command, parsed.data.args);
      if (spaced !== undefined) throw new TaviError("INVALID_INPUT", spaced);
      const folder = folderOf(context);
      // The shell's HOME and TMPDIR are in the managed folder: without it there is nowhere to run.
      if (folder.managedUnavailable !== undefined) throw new TaviError("UNAVAILABLE", folder.managedUnavailable);
      await options.space?.admitRun(folder, context.runId);
      // A turn can become tainted after admission: the gate's own taint for this call counts too,
      // and so does what it reaches that a tainted chat wrote — a tainted chat's folder, as stamped or
      // recorded since, and a host file still holding marked bytes: the run reads it before it writes.
      const late = (await options.taintedFoldersNow?.(context)) ?? [];
      const marks =
        options.hostMarks === undefined ? [] : await currentHostMarks(await options.hostMarks(context, hostFoldersOf(base, folder)));
      const written = [...new Set([...late.map((taint) => taint.taskId), ...marks.flatMap((mark) => mark.taskId ?? [])])];
      const tainted =
        folder.tainted === true ||
        operationEnvelope?.tainted === true ||
        (contextLabel !== undefined && isUntrusted(contextLabel)) ||
        (folder.taintedFolders?.length ?? 0) > 0 ||
        late.length > 0 ||
        marks.length > 0;
      // The grants as written (`@registries`), for what the result says; a preset is the domains it names.
      const granted = tainted ? [] : await grantedDomainsFor(options, context.workspaceId);
      // Hosts the person approved for this run on its card (`requestDomains`, under `sandbox.network ask`).
      const asking = !tainted && (await options.workspaceNetwork?.(context.workspaceId)) === "ask";
      const asked = requestedDomains(parsed.data.requestDomains ?? [], asking, tainted);
      const domains = expandSandboxDomains(unique([...granted, ...asked]));
      const credentials = tainted ? [] : (options.credentials ?? []);
      const confined = policyFor(base, folder, tainted, domains, credentials);
      const timeoutMs = parsed.data.timeoutMs === undefined ? undefined : Math.min(parsed.data.timeoutMs, base.maxTimeoutMs);
      const policy = timeoutMs === undefined ? confined : { ...confined, resources: { ...confined.resources, timeoutMs } };
      const secrets = await credentialSecrets(options, credentials);
      // Checked on the resolved path, independent of whatever the real sandbox runtime does with `cwd`.
      const cwd = cwdFor(folder, parsed.data.cwd);
      ensureOwnFolder(folder.home);
      ensureOwnFolder(folder.scratch);
      // A whole command line in `command` runs as the program and arguments it names, or through
      // `/bin/sh -c` when it needs a shell — as the call's assessment read it.
      const argv = sandboxArgv(parsed.data.command, parsed.data.args);
      // The shell can read what a web page supplied once a download is in the chat's folder:
      // its result is untrusted whenever `downloads/` holds anything, before or after the run.
      const downloadsBefore = holdsDownloads(base.dataDirectory, folder);
      // What the host runs on purpose (package.json's scripts, a Makefile, other agents' instructions), as it stood.
      const hostFolders = hostFoldersOf(base, folder);
      const sensitiveBefore = sensitiveFilesNow(hostFolders);
      if (tainted) await options.markFolderTainted?.(context);
      const result = await dispatchSandboxedTool(
        {
          id: "sandbox.run",
          sink: "none",
          version: "1.0.0",
          description: "Run a command inside the sandboxed execution environment.",
          effect: "external",
          requiredPermissions: ["tools.invoke"],
          requiresSandbox: true,
        },
        sandbox,
        policy,
        {
          command: argv.command,
          ...(argv.split || argv.shell ? { args: [...argv.args] } : parsed.data.args === undefined ? {} : { args: parsed.data.args }),
          ...(parsed.data.stdin === undefined ? {} : { stdin: parsed.data.stdin }),
          cwd,
          env: environmentFor(base, folder, policy, await base.gitIdentity()),
          inheritEnv: false,
          denyEnv: base.denyEnv,
          ...(credentials.length === 0 ? {} : { secrets }),
        },
      )
        .catch(async (error: unknown) => {
          // A run that failed after a request got through (out of memory, say) still left what it fetched in the chat's folder.
          if (error instanceof TaviError && error.details?.[SANDBOX_REACHED_NETWORK_DETAIL] === true)
            await options.markFolderTainted?.(context);
          throw error;
        })
        .finally(() => options.space?.forgetFolder(folder.managed));
      // A request that got through brought in what a host sent: the output is untrusted, and so is what the run left in
      // the chat's folder. Granted domains alone say nothing — an offline command or a refused request reaches no one.
      const reached = unique((result.requests ?? []).filter((request) => request.allowedCount > 0).map((request) => request.host));
      if (reached.length > 0) await options.markFolderTainted?.(context);
      // So it can whenever a folder it reaches belongs to a tainted chat.
      const untrusted = downloadsBefore || holdsDownloads(base.dataDirectory, folder) || (folder.taintedFolders?.length ?? 0) > 0;
      // What it prints from a host folder is the person's files, as `fs.read`'s is: personal; and what a
      // tainted chat wrote, read since the turn began or in a marked host file, is that chat's (`sandbox`).
      const personal = reachesHostFolder(base, folder) ? { confidentiality: "personal" as const } : {};
      // The chats whose folders or files it reached, and the hosts it reached, as `sandbox` refs.
      const refs = unique([
        ...[...written, ...(folder.taintedFolders ?? []).map((taint) => taint.taskId)].map((taskId) => `chat:${taskId}`),
        ...reached.map((host) => `host:${host}`.slice(0, CONTENT_LABEL_LIMITS.maxRefLength)),
      ]).slice(0, 16);
      const wrote =
        late.length > 0 || marks.length > 0 || reached.length > 0 ? { untrusted: true as const, source: "sandbox" as const, refs } : {};
      const labelled = Object.keys({ ...personal, ...wrote }).length === 0 ? {} : { [TOOL_LABEL_KEY]: { ...personal, ...wrote } };
      const ran = {
        ...(argv.split || argv.shell ? { ranAs: [argv.command, ...argv.args] } : {}),
        ...(timeoutMs !== undefined && timeoutMs < (parsed.data.timeoutMs ?? 0)
          ? { note: `timeoutMs is at most ${base.maxTimeoutMs}` }
          : {}),
        ...networkNote(result, tainted, unique([...granted, ...asked]), asking),
        ...writeNote(result, tainted, policy.filesystem.allowWrite, folder.managed),
        ...timeoutNote(result, policy.resources.timeoutMs, base.maxTimeoutMs),
        ...limitsNote(result),
        ...askedNote(input),
        ...sensitiveNote(changedSensitiveFiles(sensitiveBefore, sensitiveFilesNow(hostFolders))),
      };
      return untrusted ? { ...result, ...ran, ...labelled, [TOOL_UNTRUSTED_KEY]: true } : { ...result, ...ran, ...labelled };
    },
  });
}

/** What a failed write says on each platform when the sandbox refused it: Seatbelt's EPERM, bubblewrap's read-only mounts. */
const REFUSED_WRITE = /Operation not permitted|Read-only file system|EROFS|EPERM/;

/**
 * On a refused write, where this run may write and why not elsewhere, so the
 * next try aims at one of those folders or uses the file tools, whose diff
 * the person approves.
 */
function writeNote(
  result: SandboxRunResult,
  tainted: boolean,
  writable: readonly string[],
  managed: string,
): { readonly writeRefused?: string } {
  // Seatbelt's EPERM is also what a refused connection prints: the text alone counts only when no connection was
  // refused. Any other refusal (a service lookup, a `socket`) is no connection, and leaves a refused write's words.
  const connectionRefused =
    result.violations?.some((violation) => violation.kind === "network") === true ||
    result.requests?.some((request) => !request.allowed) === true;
  // Where the platform reports every refusal (macOS), the write violations alone say so; elsewhere the error
  // text counts only when no refused read or connection explains it.
  const readRefused = result.violations?.some((violation) => violation.kind === "read") === true;
  // git's own words for a config or hook it could not write are a refused write whatever the report holds (macOS
  // may file no write for it).
  const gitRefused = result.exitCode !== 0 && REFUSED_WRITE.test(result.stderr) && refusedRepositories(result.stderr).length > 0;
  const refused =
    gitRefused ||
    result.violations?.some((violation) => violation.kind === "write") === true ||
    (result.violationsComplete !== true &&
      result.exitCode !== 0 &&
      !connectionRefused &&
      !readRefused &&
      REFUSED_WRITE.test(result.stderr));
  if (!refused) return {};
  const folders = unique(writable).join(", ");
  const why = tainted
    ? "this chat holds untrusted content, so its shell writes only the chat's own folder"
    : "the shell writes only the chat's folders, and never git hooks and config, shell profiles or editor and agent settings in them";
  // `git init .` at the top of the chat's own folder writes the `.git/config` the shell never may there: a subfolder
  // is the way. A host folder's `.git` is closed at any depth, so the hint is only for the chat's own folder's top.
  const gitConfig = refusedRepositories(result.stderr).some((repository) => sameFolder(repository, managed))
    ? ". A repository at the top of the chat's folder cannot be made here: run git init or git clone into a subfolder (git init repo)"
    : "";
  return {
    writeRefused: `${why}; it may write: ${folders}. To change another file, use fs.write or fs.edit, whose change is shown for approval${gitConfig}`,
  };
}

/** The repositories whose `.git/config` or hooks a run's stderr says it could not write. */
function refusedRepositories(stderr: string): string[] {
  return [...stderr.matchAll(/(\/[^\s'":]+?)\/\.git\/(?:config|hooks)\b/g)].map((match) => match[1] as string);
}

/** Whether two paths name one folder, a link (macOS's /var → /private/var) read through. */
function sameFolder(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return left === right || real(left) === real(right);
}

/** A run stopped at its timeout: how long the next may ask for. */
function timeoutNote(result: SandboxRunResult, timeoutMs: number, maxTimeoutMs: number): { readonly timedOut?: string } {
  if (result.timedOut !== true) return {};
  return timeoutMs >= maxTimeoutMs
    ? { timedOut: `stopped after ${Math.round(timeoutMs / 1000)} s, the longest a run may take; split the work into shorter runs` }
    : { timedOut: `stopped after ${Math.round(timeoutMs / 1000)} s; run it again with timeoutMs up to ${maxTimeoutMs}` };
}

/** A run that hit its process or CPU cap: what happened, and the operator flag that raises it. */
function limitsNote(result: SandboxRunResult): { readonly limits?: string } {
  const hit = result.limitsHit;
  if (hit === undefined) return {};
  const parts = [
    ...(hit.pidsExhausted === true
      ? ["it reached its cap on processes and threads, so a fork failed (fewer parallel workers, or the operator raises --sandbox-pids)"]
      : []),
    ...(hit.cpuThrottledMs !== undefined && hit.cpuThrottledMs >= 1_000
      ? [`it was held back ${Math.round(hit.cpuThrottledMs / 1000)} s by its CPU share (the operator raises --sandbox-cpu)`]
      : []),
  ];
  return parts.length === 0 ? {} : { limits: parts.join("; ") };
}

/** Files the host runs on purpose that this run made, changed or removed: for the person to look at before running them. */
function sensitiveNote(changed: readonly string[]): { readonly hostRunsChanged?: readonly string[] } {
  return changed.length === 0 ? {} : { hostRunsChanged: changed.slice(0, 32) };
}

/** A line no grant can cover: why, and how to write it so a grant can. */
function askedNote(input: unknown): { readonly askedEveryTime?: string } {
  const assessment = assessSandboxRun(input);
  if (assessment.onceOnly !== true) return {};
  const why = assessment.display.detail?.replace(/^asked every time: it /, "").replace(/\. Split into .*$/, "");
  return {
    askedEveryTime: `this line is approved each time it runs${why === undefined ? "" : ` (it ${why})`}; written as separate plain commands without that, an approval can cover it`,
  };
}

/**
 * The domains a call asked the person for, once its card was approved: refused
 * when the workspace does not let the shell ask, in a chat holding untrusted
 * content, or for a host no run may ask for.
 */
function requestedDomains(requested: readonly string[], asking: boolean, tainted: boolean): readonly string[] {
  if (requested.length === 0) return [];
  if (tainted)
    throw new TaviError(
      "INVALID_INPUT",
      "this chat holds untrusted content, so its shell has no network; requestDomains cannot change that",
    );
  if (!asking) throw new TaviError("INVALID_INPUT", NO_ASKING);
  return requested.map((entry) => {
    const domain = requestableSandboxDomain(entry);
    if (domain === undefined)
      throw new TaviError(
        "INVALID_INPUT",
        `requestDomains takes one host by name, with an optional :port (pypi.org, api.example.com:443): ${JSON.stringify(entry)} is a pattern, an address, a paste site or no host`,
      );
    return domain;
  });
}

/** On a refused connection, the domains this run could reach, so the next try aims at one of them or asks for one. */
function networkNote(
  result: SandboxRunResult,
  tainted: boolean,
  domains: readonly string[],
  asking: boolean,
): { readonly networkRefused?: string } {
  const refusedHosts = unique((result.requests ?? []).filter((request) => !request.allowed).map((request) => request.host));
  const refused = result.violations?.some((violation) => violation.kind === "network") === true || refusedHosts.length > 0;
  // Only what a run may ask for is named: a paste site or an address would be refused again.
  const askable = refusedHosts.filter((host) => requestableSandboxDomain(host) !== undefined);
  if (!refused) return {};
  if (tainted) return { networkRefused: "this chat holds untrusted content, so its shell has no network" };
  // Under `sandbox.network ask`, the way on: name the hosts in `requestDomains` and the person approves them.
  const ask = asking
    ? `; to reach another, run again with it in requestDomains${askable.length === 0 ? "" : ` (refused: ${askable.slice(0, 8).join(", ")})`} and the person is asked`
    : "";
  if (domains.length === 0)
    return { networkRefused: `no domain is granted to the shell; the operator grants them (sandbox.domains)${ask}` };
  const shown = domains.slice(0, 20).join(", ");
  return { networkRefused: `the shell reaches only: ${shown}${domains.length > 20 ? `, and ${domains.length - 20} more` : ""}${ask}` };
}
