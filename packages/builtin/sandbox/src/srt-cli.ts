import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { TaviError, refusedUnixSocketFolder, type ConfinedCommand, type ConfinedLaunch, type ConfinementPort } from "@tavi/contracts";
import { writeJsonAtomic } from "@tavi/node-kit";

import { proxyCa } from "./ca.js";
import { PRIVATE_RANGES, egressDenyLists, type HostProcessRequest } from "./egress.js";
import { hostProcessPath, shellQuote, srtHelperConfig } from "./paths.js";

import { compile, nodeCompileFs, type CompileFs } from "./policy-compile.js";

/** Where `tavi sandbox setup` puts its own bubblewrap on Ubuntu: kept here so the engine, the CLI seam and detection agree. */
export const TAVI_BWRAP = "/opt/tavi/libexec/bwrap";

/**
 * The srt CLI seam: one `srt` process per confined child, with its own
 * settings file. Lifted from the MCP stdio launcher so the PDF parser child
 * runs under the same wrapper. The owner
 * reaches it only through `createSrtConfinement`, a `ConfinementPort`.
 *
 * `SandboxPort.run` cannot carry these children: it returns capped stdout and
 * stderr strings for a rendered shell command, while they stream binary.
 */

/** The srt CLI this build ships (`@anthropic-ai/sandbox-runtime`, exact pin). */
export function srtCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist", "cli.js");
}

/** srt's vendored helpers (its Linux seccomp helper runs from here, inside the namespace). */
export function srtHelpersDirectory(): string {
  return join(dirname(dirname(srtCliPath())), "vendor");
}

/**
 * What a confined Node child reads of Tavi's own node, wherever it lives
 * (inside `$HOME` under nvm, say): its install directory, unless that is (or
 * holds) one of `deniedRoots`, when only the binary's own directory.
 */
export function nodeReadRoot(deniedRoots: readonly string[], execPath: string = process.execPath): string {
  const install = dirname(dirname(execPath));
  const wide = deniedRoots.some((root) => root === install || root.startsWith(`${install}/`));
  return wide ? dirname(execPath) : install;
}

/** A confined child's policy, in srt's settings shape. */
export interface SrtPolicy {
  readonly allowedDomains: readonly string[];
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  /** srt inside a container that cannot nest namespaces: the weaker nested mode. */
  readonly nested: boolean;
  /** The bubblewrap srt runs: `tavi sandbox setup`'s copy where it made one. */
  readonly bwrapPath?: string;
  /** Folders Unix sockets may live in (macOS; `ConfinementPolicy.unixSockets`). */
  readonly unixSockets?: readonly string[];
  /** srt's Linux helpers by absolute path (`srtHelperConfig`), so a narrow `PATH` still runs them. */
  readonly helpers?: { readonly socatPath?: string; readonly ripgrep?: { readonly command: string } };
}

/** The socket folders a confined child is given: never a container engine's daemon, which would hand it the host. */
function allowedSockets(paths: readonly string[]): readonly string[] {
  for (const path of paths) {
    const refused = refusedUnixSocketFolder(path);
    if (refused !== undefined) throw new TaviError("INVALID_INPUT", refused);
  }
  return paths;
}

/**
 * srt's settings for `policy`, from the one compiler: a strict domain
 * allowlist (none reaches nothing), writes only where allowed, and srt's own
 * shared write paths closed, as for `sandbox.run`. A child granted domains
 * gets `sandbox.run`'s deny lists too (`egressDenyLists`): paste and
 * file-drop sites, and private ranges a granted name must not resolve into.
 * One that may reach every host (the browser) gets neither: a person's
 * browser opens those pages, and the browser tools' page rules govern where it
 * goes; this host and metadata addresses stay closed in the host process.
 */
export function srtSettingsOf(
  policy: SrtPolicy,
  platform: NodeJS.Platform = process.platform,
  fs: CompileFs = nodeCompileFs,
  home?: string,
): SandboxRuntimeConfig {
  const { config } = compile(
    {
      filesystem: { denyRead: policy.denyRead, allowRead: policy.allowRead, allowWrite: policy.allowWrite },
      network: { allow: policy.allowedDomains.length > 0, allowedHosts: policy.allowedDomains },
      resources: { timeoutMs: 0, maxOutputBytes: 0 },
    },
    {},
    platform === "linux" ? "linux" : "darwin",
    fs,
    home === undefined ? {} : { home },
  );
  const network = {
    ...config.network,
    ...(policy.allowedDomains.length === 0 || policy.allowedDomains.includes("*") ? {} : egressDenyLists(policy.allowedDomains)),
    ...(policy.unixSockets === undefined || policy.unixSockets.length === 0
      ? {}
      : { allowUnixSockets: [...allowedSockets(policy.unixSockets)] }),
  };
  return {
    ...config,
    network,
    ...(policy.nested ? { enableWeakerNestedSandbox: true } : {}),
    ...(policy.bwrapPath === undefined ? {} : { bwrapPath: policy.bwrapPath }),
    ...(platform === "linux" ? (policy.helpers ?? {}) : {}),
  };
}

/**
 * What srt, and the Node running it, read for themselves: its parent proxy,
 * certificates, sockets and files. A child's variable (a bundle's or a
 * registry listing's) never sets one for srt; `TMPDIR` is the system's, where
 * srt keeps its proxy sockets (a Unix socket path is at most 104 bytes on
 * macOS, and a child's home may sit deep).
 */
const SRT_OWN =
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|NODE_V8_COVERAGE|NODE_REDIRECT_WARNINGS|NODE_COMPILE_CACHE|NODE_DEBUG|CLAUDE_TMPDIR|CLAUDE_CODE_TMPDIR|SRT_.*|TMPDIR)$/i;

/** The proxy variables: srt sets the child's own, toward itself. */
const PROXY = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;

/** srt's own environment: the child's, without what srt reads for itself (`SRT_OWN`). */
export function srtEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SRT_OWN.test(name)));
}

/**
 * srt's argv: its settings, then the child's argv with the child's `TMPDIR`,
 * and the other variables kept from srt but not from the child, set inside
 * the sandbox (never a proxy: srt sets those).
 */
export function srtArgs(settingsFile: string, env: Readonly<Record<string, string>>, argv: readonly string[]): string[] {
  const inside = Object.entries(env)
    .filter(([name]) => name !== "TMPDIR" && SRT_OWN.test(name) && !PROXY.test(name))
    .map(([name, value]) => `${name}=${value}`);
  return [srtCliPath(), "--settings", settingsFile, "--", "/usr/bin/env", `TMPDIR=${env["TMPDIR"] ?? ""}`, ...inside, ...argv];
}

/**
 * The srt CLI as a `ConfinementPort`: each launch's
 * policy is written to its own file, whole (a temporary file renamed over
 * it, so a child starting under the old file never reads half of the new),
 * with the owner's Node and srt's helpers readable whatever is denied.
 */
export function createSrtConfinement(
  options: {
    /** Read-denied for every child whatever its policy says: the owner's staging. */
    readonly alwaysDenyRead?: readonly string[];
    /** The bubblewrap srt runs, read at each wrap; by default `tavi sandbox setup`'s copy on Linux when it exists. */
    readonly bwrapPath?: () => string | undefined;
    /** Where the CA for a child's credentials lives (`ca.ts`); without it a launch with credentials is refused. */
    readonly caDirectory?: string;
    /** What the compiler targets and reads (the golden configs replace them); the real platform and filesystem by default. */
    readonly platform?: NodeJS.Platform;
    readonly fs?: CompileFs;
    readonly home?: string;
    /** Where srt's Linux helpers are; default `helperPath`. */
    readonly helperPath?: (name: string) => string | undefined;
  } = {},
): ConfinementPort {
  const bwrapPath = options.bwrapPath ?? (() => (process.platform === "linux" && existsSync(TAVI_BWRAP) ? TAVI_BWRAP : undefined));
  return {
    wrap(launch: ConfinedLaunch): ConfinedCommand {
      // srt confines on macOS and Linux only: elsewhere (Windows) a launch is refused, never run under a policy compiled for another platform.
      const platform = options.platform ?? process.platform;
      if (platform !== "darwin" && platform !== "linux")
        throw new TaviError(
          "UNAVAILABLE",
          `The sandbox runs on macOS and Linux, not ${platform}, so a confined child is not started here` +
            (platform === "win32" ? "; run Tavi inside WSL2" : ""),
        );
      const { policy } = launch;
      const allowRead = [...new Set([nodeReadRoot(policy.denyRead), srtHelpersDirectory(), ...policy.allowRead])];
      const denyRead = [...new Set([...policy.denyRead, ...(options.alwaysDenyRead ?? [])])];
      const bwrap = bwrapPath();
      const srtPolicy: SrtPolicy = {
        allowedDomains: policy.domains,
        denyRead,
        allowRead,
        allowWrite: policy.allowWrite,
        nested: policy.nested,
        ...(bwrap === undefined ? {} : { bwrapPath: bwrap }),
        ...(policy.unixSockets === undefined ? {} : { unixSockets: policy.unixSockets }),
        ...((options.platform ?? process.platform) === "linux" ? { helpers: srtHelperConfig(options.helperPath) } : {}),
      };
      const settings = withCredentials(srtSettingsOf(srtPolicy, options.platform, options.fs, options.home), launch, options.caDirectory);
      // Every host (`*`, the browser's): srt's CLI refuses that pattern, so the child runs in a Tavi srt host process,
      // whose ask callback lets each host through but this one, link-local and metadata addresses (`neverDialed`);
      // the paste-site deny list and srt's guard on what a name resolves to (loopback, link-local, metadata) still apply.
      const everyHost = policy.domains.includes("*");
      // The browser, held off the private network: srt's resolved-address guard drops a private answer and dials what it checked.
      const held =
        policy.privateAddresses === undefined
          ? settings
          : {
              ...settings,
              network: {
                ...settings.network,
                deniedResolvedAddresses: [...new Set([...(settings.network.deniedResolvedAddresses ?? []), ...PRIVATE_RANGES])],
              },
            };
      const written = everyHost ? hostProcessRequest(held, launch) : held;
      writeJsonAtomic(launch.policyFile, written, { indent: 2, trailingNewline: true });
      // A child holding credentials loaded its CA at start: it is started again a day before that one runs out.
      const expires = caExpiry.get(settings);
      const renewal = expires === undefined ? {} : { renewBy: expires - RENEW_CHILD_BEFORE_MS };
      if (everyHost)
        return {
          command: process.execPath,
          args: [hostProcessPath(), "--request", launch.policyFile],
          env: srtEnvironment(launch.env),
          ...renewal,
        };
      return {
        command: process.execPath,
        args: srtArgs(launch.policyFile, launch.env, launch.argv),
        env: srtEnvironment(launch.env),
        ...renewal,
      };
    },
  };
}

/**
 * srt's settings with the launch's credentials masked: each named
 * variable becomes a placeholder in the child, put back by the proxy toward
 * its hosts only, whose TLS alone it terminates with the owner's CA; every
 * other domain stays an opaque tunnel. srt reads the values from its own
 * environment, the launch's.
 */
/** How long before its CA runs out a child holding credentials is started again. */
const RENEW_CHILD_BEFORE_MS = 86_400_000;

/** When the CA a launch's settings were given runs out, by the settings it was given to (`renewBy`). */
const caExpiry = new WeakMap<SandboxRuntimeConfig, number>();

function withCredentials(settings: SandboxRuntimeConfig, launch: ConfinedLaunch, caDirectory: string | undefined): SandboxRuntimeConfig {
  const credentials = launch.policy.credentials ?? [];
  if (credentials.length === 0) return settings;
  if (caDirectory === undefined)
    throw new TaviError(
      "UNAVAILABLE",
      "a confined child with credentials needs a private folder for the proxy's certificate authority, and none is configured",
    );
  for (const credential of credentials) {
    if (launch.env[credential.env] === undefined)
      throw new TaviError("NOT_CONFIGURED", `credential ${credential.env} has no value for this child`);
    const bad = credential.hosts.find((host) => !/^[a-z0-9.-]+$/.test(host) || !launch.policy.domains.includes(host));
    if (bad !== undefined)
      throw new TaviError(
        "INVALID_INPUT",
        `credential ${credential.env}'s host ${bad} must be an exact host, with no port, among the child's domains`,
      );
  }
  const injectHosts = new Set(credentials.flatMap((credential) => credential.hosts));
  const { certPath, keyPath, expires } = proxyCa(caDirectory);
  const existing = settings.credentials?.envVars ?? [];
  const masked = new Set(credentials.map((credential) => credential.env));
  const given: SandboxRuntimeConfig = {
    ...settings,
    credentials: {
      ...settings.credentials,
      envVars: [
        ...existing.filter((entry) => !masked.has(entry.name)),
        ...credentials.map((credential) => ({ name: credential.env, mode: "mask" as const, injectHosts: [...credential.hosts] })),
      ],
    },
    network: {
      ...settings.network,
      // srt matches excludeDomains by name: a domain's port is dropped, or it would never be excluded.
      tlsTerminate: {
        caCertPath: certPath,
        caKeyPath: keyPath,
        excludeDomains: [...new Set(launch.policy.domains.map((domain) => domain.replace(/:\d+$/, "")))].filter(
          (domain) => ![...injectHosts].some((host) => host === domain || (domain.startsWith("*.") && host.endsWith(domain.slice(1)))),
        ),
      },
    },
  };
  caExpiry.set(given, expires);
  return given;
}

/** The host process's request for a confined child that may reach every host: srt's settings, the child's line and its own environment. */
function hostProcessRequest(settings: SandboxRuntimeConfig, launch: ConfinedLaunch): HostProcessRequest {
  const line = ["/usr/bin/env", `TMPDIR=${launch.env["TMPDIR"] ?? ""}`, ...launch.argv].map(shellQuote).join(" ");
  return {
    config: settings,
    grants: ["*"],
    line,
    cwd: launch.env["HOME"] ?? "/",
    env: Object.fromEntries(Object.entries(launch.env).filter(([name]) => !PROXY.test(name))),
    inheritEnv: false,
    ...(launch.policy.privateAddresses === undefined ? {} : { privateAddresses: { except: [...launch.policy.privateAddresses.except] } }),
  };
}
