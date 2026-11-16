import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SANDBOX_DENIED_DOMAINS, type SandboxCredential } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { embeddedIPv4 } from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";

/**
 * Network runs' protocol with the Tavi srt host process and the grant matcher both sides share.
 */

/** What the owner sends, one JSON line on fd 3. */
export interface HostProcessRequest {
  /** srt's config, compiled by the owner; `allowedDomains` is ignored, the grants decide. */
  readonly config: SandboxRuntimeConfig;
  /** The domains this run may reach (patterns as srt reads them: `*.example.com`, `api.example.com:443`). */
  readonly grants: readonly string[];
  /** The shell line to run. */
  readonly line: string;
  readonly cwd: string;
  /** The command's environment: its whole one with `inheritEnv: false`, else laid over the wrapper's. */
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  /** No private or CGNAT address but these (`ConfinementPolicy.privateAddresses`): refused by number here, by name by srt's guard. */
  readonly privateAddresses?: { readonly except: readonly string[] };
  /**
   * The proxy granted connections leave through (`serve --sandbox-parent-proxy`).
   * srt does not check what a name resolves to on that hop, so this process
   * does, before it lets the connection through.
   */
  readonly parentProxy?: string;
  /**
   * `serve --sandbox-inspect-tls`: the proxy terminates TLS toward every grant
   * with this CA, and refuses a tunnel it cannot inspect (git over SSH, a raw
   * TCP protocol), so a request is judged by the host it names, not the one
   * its tunnel was opened to.
   */
  readonly inspectTls?: { readonly caCertPath: string; readonly caKeyPath: string };
  /** fd 4 is the run's marker (macOS): the command inherits it, so the owner's sweep finds whatever of the run outlives it. */
  readonly marker?: boolean;
  /** Credentials the proxy injects, with their real values by `env`, and the CA it terminates their hosts' TLS with. */
  readonly credentials?: {
    readonly entries: readonly SandboxCredential[];
    readonly secrets: Readonly<Record<string, string>>;
    readonly caCertPath: string;
    readonly caKeyPath: string;
  };
}

/** What the host process reports, one JSON line each on fd 3. */
export type HostProcessEvent =
  | { readonly type: "request"; readonly host: string; readonly port: number; readonly allowed: boolean }
  | { readonly type: "violation"; readonly line: string }
  /** The proxy put these credentials into a request to `host:port`. */
  | { readonly type: "inject"; readonly host: string; readonly port: number; readonly credentials: readonly string[] }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: string | null }
  /** The run could not start, or its command could not spawn; `profileError` is bubblewrap's refusal of the profile. */
  | { readonly type: "error"; readonly message: string; readonly profileError?: string };

/**
 * One fd-3 line's event, when it has the shape of one: the host process is
 * Tavi's own, but it runs beside the command, so a line that is not one is
 * dropped as one that does not parse is.
 */
export function hostProcessEventOf(value: unknown): HostProcessEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  const integer = (key: string): boolean => Number.isInteger(event[key]);
  const text = (key: string): boolean => typeof event[key] === "string";
  const nullable = (key: string, test: (key: string) => boolean): boolean => event[key] === null || test(key);
  switch (event["type"]) {
    case "request":
      return text("host") && integer("port") && typeof event["allowed"] === "boolean" ? (value as HostProcessEvent) : undefined;
    case "violation":
      return text("line") ? (value as HostProcessEvent) : undefined;
    case "inject":
      return text("host") &&
        integer("port") &&
        Array.isArray(event["credentials"]) &&
        event["credentials"].every((name) => typeof name === "string")
        ? (value as HostProcessEvent)
        : undefined;
    case "exit":
      return nullable("code", integer) && nullable("signal", text) ? (value as HostProcessEvent) : undefined;
    case "error":
      return text("message") && (event["profileError"] === undefined || text("profileError")) ? (value as HostProcessEvent) : undefined;
    default:
      return undefined;
  }
}

/** Whether `host:port` is one of `grants`, by srt's own matcher. */
export function granted(grants: readonly string[], host: string, port: number): boolean {
  return grants.some((pattern) => matchesDomainPatternWithPort(host, port, pattern));
}

/** Headers that carry a credential: one going to an inject host must be the placeholder's (no key of the command's own). */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-api-key", "api-key", "x-auth-token", "private-token", "x-goog-api-key"] as const;

/** A credential as the proxy checks it: its declaration and the placeholder the command sees. */
export interface ArmedCredential extends SandboxCredential {
  readonly sentinel: string;
}

/** Whether `host` is one of a credential's exact hosts: srt matches inject hosts without a port, so they never carry one. */
export function injectsAt(credential: SandboxCredential, host: string): boolean {
  return credential.hosts.includes(host.toLowerCase());
}

/** Whether `body` holds `needle`, read in chunks, never whole: a chunk boundary may split it. */
export async function streamHolds(body: ReadableStream<Uint8Array> | null, needles: readonly string[]): Promise<boolean> {
  if (body === null || needles.length === 0) return false;
  const longest = Math.max(...needles.map((needle) => needle.length));
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      const text = tail + decoder.decode(value, { stream: true });
      if (needles.some((needle) => text.includes(needle))) return true;
      tail = text.slice(-(longest - 1));
    }
  } finally {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Whether a path means the same to the prefix check and to the far end.
 * srt hands the check the WHATWG-normalized URL (dot segments, `%2e` among
 * them, resolved) while it forwards the client's path as sent, so an encoded
 * separator, dot or percent (`/v1/..%2fadmin`, which a server may decode and
 * resolve to `/admin`) or a dot segment left after decoding is refused.
 */
function plainPath(pathname: string): boolean {
  if (/%(?:2f|5c|2e|25)/i.test(pathname)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return !decoded.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
}

/**
 * The proxy's decision on one parsed request (`filterRequest`): at a
 * credential's host, every credential header must carry a placeholder in the
 * header it is declared for (else the command brought a key of its own); a
 * placeholder anywhere else there (the URL, another header, the body) is
 * refused, since the proxy would put the real value where the far end could
 * send it back; the credential's methods and path prefixes hold. Elsewhere a
 * request passes, placeholders and all: they go out as placeholders.
 */
export async function decideRequest(
  request: Request,
  credentials: readonly ArmedCredential[],
): Promise<{ readonly action: "allow" | "deny"; readonly reason?: string; readonly injected: readonly string[] }> {
  const url = new URL(request.url);
  const here = credentials.filter((credential) => injectsAt(credential, url.hostname));
  if (here.length === 0) return { action: "allow", injected: [] };
  const deny = (reason: string) => ({ action: "deny" as const, reason, injected: [] });
  // srt forwards a GET, HEAD or OPTIONS body (substituted) but shows this check none: one declaring a body is refused here.
  if (
    ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) &&
    (Boolean(request.headers.get("content-length")) || Boolean(request.headers.get("transfer-encoding")))
  ) {
    return deny(`a ${request.method} request with a body may not go to a credential's host`);
  }
  const headerOf = (credential: ArmedCredential): string => (credential.header ?? "authorization").toLowerCase();
  if (here.some((credential) => request.url.includes(credential.sentinel)))
    return deny("a credential's placeholder may not travel in the URL");
  for (const [name, value] of request.headers) {
    const carried = here.filter((credential) => value.includes(credential.sentinel));
    if (carried.some((credential) => headerOf(credential) !== name))
      return deny(`a credential's placeholder may travel only in its own header, not ${name}`);
    if ((CREDENTIAL_HEADERS as readonly string[]).includes(name) && carried.length === 0) {
      return deny(`${name} to ${url.hostname} must be the sandbox's credential placeholder, not a key of the command's own`);
    }
  }
  const injected = here.filter((credential) => request.headers.get(headerOf(credential))?.includes(credential.sentinel) === true);
  for (const credential of injected) {
    if (credential.methods !== undefined && !credential.methods.includes(request.method.toUpperCase()))
      return deny(`${credential.env} may not be used with ${request.method}`);
    if (
      credential.pathPrefixes !== undefined &&
      (!plainPath(url.pathname) || !credential.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
    )
      return deny(`${credential.env} may not be used on ${url.pathname}`);
  }
  if (
    await streamHolds(
      request.body,
      here.map((credential) => credential.sentinel),
    )
  )
    return deny("a credential's placeholder may not travel in the request body");
  // srt substitutes only on the TLS it terminates: over plain HTTP the placeholder goes out as it is.
  return { action: "allow", injected: url.protocol === "https:" ? injected.map((credential) => credential.env) : [] };
}

/** Hosts no grant opens: paste and file-drop sites, where anything sent is published. */
export const DEFAULT_DENIED_DOMAINS = SANDBOX_DENIED_DOMAINS;
const DEFAULT_DENIED_REASONS: Readonly<Record<string, string>> = Object.fromEntries(
  DEFAULT_DENIED_DOMAINS.map((domain) => [
    domain,
    "a paste or file-drop site: what is sent there is published; the sandbox never reaches one",
  ]),
);
/** Private and shared address space an allowed name must not resolve to (RFC 1918, CGNAT, ULA). */
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"] as const;
const PRIVATE = new BlockList();
for (const range of PRIVATE_RANGES) {
  const [address = "", prefix = ""] = range.split("/");
  PRIVATE.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
}

/**
 * Whether a connection to `host:port` is refused for naming a private,
 * unique-local or CGNAT address by number (in any spelling srt dials), and
 * the operator did not list it (`except`: an address, optionally with
 * `:port`). A name is left to srt's resolved-address guard, which checks
 * what it resolves to with the same ranges.
 */
export function privateRefused(host: string, port: number, except: readonly string[]): boolean {
  const name = dialedHost(host);
  if (name === undefined || isIP(name) === 0) return false;
  const forms = [name, embeddedIPv4(name)].filter((form): form is string => form !== undefined);
  if (!forms.some((form) => PRIVATE.check(form, isIP(form) === 6 ? "ipv6" : "ipv4"))) return false;
  const bracketed = isIP(name) === 6 ? `[${name}]` : name;
  return !except.some((entry) => {
    const listed = entry.toLowerCase();
    return listed === name || listed === bracketed || listed === `${name}:${String(port)}` || listed === `${bracketed}:${String(port)}`;
  });
}

/**
 * srt's network deny lists for a run or child granted `domains`: the paste
 * and file-drop sites always, and, unless it may reach every host (`*`, the
 * browser, which reaches an intranet as a person's browser does), the
 * private ranges a granted name must not resolve into (DNS rebinding).
 */
export function egressDenyLists(
  domains: readonly string[],
  deniedDomains?: readonly string[],
): Pick<SandboxRuntimeConfig["network"], "deniedDomains" | "deniedDomainReasons" | "deniedResolvedAddresses"> {
  return {
    ...(deniedDomains === undefined
      ? { deniedDomains: [...DEFAULT_DENIED_DOMAINS], deniedDomainReasons: { ...DEFAULT_DENIED_REASONS } }
      : {
          deniedDomains: [...deniedDomains],
          // An operator's own list keeps the shipped reason for each shipped entry it still holds.
          deniedDomainReasons: Object.fromEntries(
            Object.entries(DEFAULT_DENIED_REASONS).filter(([domain]) => deniedDomains.includes(domain)),
          ),
        }),
    ...(domains.includes("*") ? {} : { deniedResolvedAddresses: [...PRIVATE_RANGES] }),
  };
}

/**
 * The host srt dials for `host` (its own `canonicalizeHost`: inet_aton
 * shorthand, hex and octal octets, IPv6 compression, an IPv4-mapped address
 * as IPv4, case and a trailing dot), or `undefined` when it is no URL host.
 * The ask callback is handed the host as the client spelled it; every check
 * is on this.
 */
export function dialedHost(host: string): string | undefined {
  return canonicalizeHost(host)?.toLowerCase();
}

/** Addresses no grant reaches: loopback, unspecified, link-local, multicast, broadcast, and cloud metadata outside link-local space. */
const NEVER_DIALED_RANGES = [
  "127.0.0.0/8",
  "::1/128",
  "0.0.0.0/8",
  "::/128",
  "169.254.0.0/16",
  "fe80::/10",
  "224.0.0.0/4",
  "ff00::/8",
  "255.255.255.255/32",
  "100.100.100.200/32",
  "168.63.129.16/32",
  "192.0.0.192/32",
  "fd00:ec2::/32",
  "fd20:ce::254/128",
  "fd00:c1::a9fe:a9fe/128",
  "fd00:42::42/128",
  "fd00:a9fe:a9fe::1/128",
  "fd00:100::100:200/128",
] as const;
const NEVER_DIALED = new BlockList();
for (const range of NEVER_DIALED_RANGES) {
  const [address = "", prefix = ""] = range.split("/");
  NEVER_DIALED.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
}

/**
 * This host's interface addresses now (a service bound to every address answers on each as on loopback);
 * undefined when they cannot be listed.
 */
function interfaceAddresses(): readonly string[] | undefined {
  try {
    return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address.replace(/%.*$/, "")));
  } catch (error) {
    // Said once (on the host process's stderr): every address literal is refused meanwhile.
    if (!interfacesUnlistedSaid) {
      interfacesUnlistedSaid = true;
      process.stderr.write(
        `tavi sandbox egress: this host's interface addresses could not be listed (${errorMessage(error)}); address literals are refused\n`,
      );
    }
    return undefined;
  }
}
let interfacesUnlistedSaid = false;

/**
 * A host no grant opens, whatever it names (`*` included): this host, by
 * name, by loopback or by any of its interface addresses; the unspecified
 * address; link-local addresses and cloud metadata. Judged on what srt
 * dials (`dialedHost`), so `127.1`, `2130706433` or `::ffff:7f00:1` are
 * loopback here too; an IPv6 address carrying an IPv4 one (NAT64, 6to4,
 * IPv4-compatible) is judged as that address as well. srt's own guard
 * checks what a name resolves to but passes an address literal and
 * `localhost` through, so they are refused here. Private networks are not:
 * a grant naming a private address reaches it.
 */
export function neverDialed(host: string, localAddresses: () => readonly string[] | undefined = interfaceAddresses): boolean {
  const name = dialedHost(host);
  if (name === undefined) return true;
  if (name === "localhost" || name.endsWith(".localhost") || name === "metadata.google.internal" || name === "metadata") return true;
  if (isIP(name) === 0) return false;
  const forms = [name, embeddedIPv4(name)].filter((form): form is string => form !== undefined);
  // With this host's addresses unknown, any address may be one of them: none is dialed.
  const addresses = localAddresses();
  if (addresses === undefined) return true;
  const local = new BlockList();
  for (const address of addresses) if (isIP(address) !== 0) local.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  return forms.some((form) => {
    const family = isIP(form) === 6 ? "ipv6" : "ipv4";
    return NEVER_DIALED.check(form, family) || local.check(form, family);
  });
}

/**
 * Whether a name resolves, here, to this host, a link-local or metadata
 * address, or a private network the operator did not open (`except`): what
 * srt's own resolved-address guard refuses on a direct dial, checked for a
 * connection that leaves through a parent proxy, where srt never sees the
 * address. Best effort: the proxy resolves the name again with its own
 * resolver. A name this host cannot resolve is left to the proxy, which a
 * host that reaches the web only through one depends on.
 */
export async function resolvesInward(
  host: string,
  port: number,
  except: readonly string[],
  resolve: (name: string) => Promise<readonly { readonly address: string }[]> = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<boolean> {
  if (isIP(host) !== 0) return neverDialed(host) || privateRefused(host, port, except);
  try {
    const addresses = await resolve(host);
    return addresses.some(({ address }) => neverDialed(address) || privateRefused(address, port, except));
  } catch {
    return false;
  }
}

/** The hosts a run dials without its parent proxy: this host, and the addresses its grants name by number. */
function directlyDialed(grants: readonly string[]): readonly string[] {
  return ["localhost", "127.0.0.1", "::1", ...grants.map((grant) => grant.replace(/:\d+$/, "")).filter((host) => isIP(host) !== 0)];
}

/**
 * The run's srt config: the grants decide each connection (srt's allowlist
 * empty, not strict), and a request the proxy reads must name the host its
 * connection was opened to. With credentials, each is masked in the
 * command's environment and injected only toward its hosts, whose TLS alone
 * is terminated, with the owner's CA (never srt's own, whose key it writes
 * into `TMPDIR`); every other grant stays an opaque tunnel. Inspected
 * (`inspectTls`), every grant's TLS is terminated and no tunnel is opaque.
 */
export function hostProcessConfig(
  request: HostProcessRequest,
  filterRequest: NonNullable<SandboxRuntimeConfig["network"]["filterRequest"]>,
): SandboxRuntimeConfig {
  // The operator's opened private addresses stay listed: srt's guard lets a name that resolves to one through to it.
  const network = {
    ...request.config.network,
    allowedDomains: [...(request.privateAddresses?.except ?? [])],
    strictAllowlist: false,
    // A request it reads (plain HTTP, terminated TLS) names the host its connection was opened to, or is refused (421)
    // rather than rewritten to it; and, where a request filter runs, a target spelled two ways is refused, not guessed.
    requireHostMatch: true,
    ambiguousRequestTarget: "refuse" as const,
    // Only the proxy the operator named: never one from this process's environment, which carries none.
    // The private addresses a grant names are dialed directly, never tunnelled to the parent proxy.
    ...(request.parentProxy === undefined
      ? {}
      : { parentProxy: { http: request.parentProxy, https: request.parentProxy, noProxy: directlyDialed(request.grants).join(",") } }),
  };
  const credentials = request.credentials === undefined || request.credentials.entries.length === 0 ? undefined : request.credentials;
  const inspect = request.inspectTls;
  if (credentials === undefined && inspect === undefined) return { ...request.config, network };
  const entries = credentials?.entries ?? [];
  const masked = new Set(entries.map((credential) => credential.env));
  const injectHosts = entries.flatMap((credential) => credential.hosts);
  const hostOf = (entry: string): string => entry.replace(/:\d+$/, "");
  // srt matches `excludeDomains` by name, without a port: a grant's port is dropped, or it would never be excluded.
  // Inspected, nothing is: every grant's TLS is terminated, and a tunnel that carries none is refused.
  const opaque =
    inspect === undefined
      ? [...new Set(request.grants.map(hostOf))].filter((grant) => !injectHosts.some((host) => granted([grant], host, 443)))
      : [];
  // Either is set here; both name the owner's one CA.
  const ca = (credentials ?? inspect) as { readonly caCertPath: string; readonly caKeyPath: string };
  return {
    ...request.config,
    ...(credentials === undefined
      ? {}
      : {
          credentials: {
            ...request.config.credentials,
            envVars: [
              // A name the owner denies by pattern is masked instead, for this run.
              ...(request.config.credentials?.envVars ?? []).filter((entry) => !masked.has(entry.name)),
              ...entries.map((credential) => ({ name: credential.env, mode: "mask" as const, injectHosts: [...credential.hosts] })),
            ],
          },
        }),
    network: {
      ...network,
      // With a credential, no cookie a response the proxy reads sets reaches the command: a session the credential's host
      // opens is never the command's to replay without it. srt strips it from every response it reads, plain HTTP too.
      ...(credentials === undefined ? {} : { stripResponseHeaders: ["set-cookie"] }),
      ...(inspect === undefined ? {} : { refuseOpaqueTunnels: true }),
      tlsTerminate: {
        caCertPath: ca.caCertPath,
        caKeyPath: ca.caKeyPath,
        excludeDomains: opaque,
      },
      filterRequest,
    },
  };
}
