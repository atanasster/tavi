import { Resolver, lookup as dnsLookup } from "node:dns/promises";

import { errorMessage } from "@tavi/contracts/util";
import { classifyAddresses, classifyIpAddress, describeAddressRefusal, isIpLiteralHost } from "@tavi/runtime";

/**
 * The browser's address rule: no approval, grant or rule lets it reach this
 * machine or a private network — loopback, RFC 1918 and ULA, link-local (the
 * cloud metadata service), carrier-grade NAT and the other special ranges
 * `web_fetch` refuses — and every `localhost` name. Only the operator's
 * `--browser-allow-host` opens one. The browser tools check a navigation's
 * URL with it; the browser's egress proxy checks every connection Chromium
 * makes and connects to the address it checked (`createEgressCheck`).
 */

/** The names a browser takes to this machine without asking DNS: `localhost` and every `*.localhost`. */
const LOOPBACK_NAME = /(^|\.)localhost$/i;
/** How long a DNS query may take: a stalled server answers nothing in time. */
const RESOLVE_TIMEOUT_MS = 2_000;
/** How long a name's answer is reused: a page's many requests to one host resolve it once. */
const RESOLVED_TTL_MS = 30_000;
const RESOLVED_MAX = 512;
/** Names resolved at once, and names waiting: past both, a name is refused rather than queued without bound. */
const RESOLVING_AT_ONCE = 4;
const WAITING_MAX = 16;
/** How long a name that timed out is refused at once, so a stalled server does not hold every request for it. */
const TIMED_OUT_TTL_MS = 15_000;
/** Resolver answers that say the name does not exist: the browser cannot reach it either. */
const NO_SUCH_NAME = new Set(["ENOTFOUND", "ENODATA"]);
const TIMED_OUT = new Set(["ETIMEOUT", "ETIMEDOUT"]);

export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/** A name only the hosts file or the local network answers: `printer.local`, a single label. */
const isLocalName = (hostname: string): boolean => !hostname.includes(".") || hostname.endsWith(".local");

/**
 * The system's answers for `hostname`, through c-ares — a query with its own
 * timeout, off the thread pool `dns.lookup` shares with file reads — both
 * families at once. A local name goes to `dns.lookup` (the hosts file, mDNS).
 */
export async function systemResolve(hostname: string): Promise<readonly string[]> {
  if (isLocalName(hostname)) return lookupBounded(hostname);
  const resolver = new Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const answers = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  if (answers.length > 0) return answers;
  // Neither family answered. A name DNS does not know may still be the system's (the hosts file, a split-DNS
  // resolver of a VPN): asked of it, bounded the same way. A timeout or another failure is the name's.
  const reason: unknown =
    v4.status === "rejected"
      ? v4.reason
      : v6.status === "rejected"
        ? v6.reason
        : Object.assign(new Error(`${hostname} has no address`), { code: "ENODATA" });
  const code = (reason as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && NO_SUCH_NAME.has(code)) return lookupBounded(hostname);
  throw reason;
}

/** `dns.lookup` for every address of `hostname`, refused as a timeout past `RESOLVE_TIMEOUT_MS`. */
async function lookupBounded(hostname: string): Promise<readonly string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }).then((answers) => answers.map((answer) => answer.address)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`resolving ${hostname} timed out`), { code: "ETIMEOUT" })),
          RESOLVE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a host names that no approval opens, from the name alone: a loopback
 * name, or an IP literal that is not public. `undefined` for a public literal
 * or a name DNS decides.
 */
export function literalAddressRefusal(hostname: string): string | undefined {
  const bare = hostname.replace(/\.$/, "");
  if (LOOPBACK_NAME.test(bare)) return describeAddressRefusal("loopback");
  if (!isIpLiteralHost(bare)) return undefined;
  const refusal = classifyIpAddress(bare);
  return refusal === undefined ? undefined : describeAddressRefusal(refusal);
}

/** A name's answer: its addresses; that it does not exist; or that it could not be checked, and whether by a timeout. */
type NameAnswer =
  | { readonly addresses: readonly string[] }
  | { readonly missing: true }
  | { readonly failed: string; readonly timedOut: boolean };

/**
 * Resolution with a bound: at most `RESOLVING_AT_ONCE` names at once and
 * `WAITING_MAX` waiting, a full queue refused; a positive answer kept briefly;
 * a domain whose name timed out refused at once for a while; a failure never
 * kept.
 */
function createNameCache(resolve: ResolveHost, now: () => number): (hostname: string) => Promise<NameAnswer> {
  const answers = new Map<string, { readonly at: number; readonly answer: Promise<NameAnswer> }>();
  const timedOut = new Map<string, number>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<boolean> => {
    if (running < RESOLVING_AT_ONCE) {
      running += 1;
      return true;
    }
    if (waiting.length >= WAITING_MAX) return false;
    await new Promise<void>((resume) => waiting.push(resume));
    running += 1;
    return true;
  };
  const free = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  const ask = async (name: string): Promise<NameAnswer> => {
    const since = timedOut.get(name);
    if (since !== undefined && now() - since < TIMED_OUT_TTL_MS) return { failed: `${name} timed out moments ago`, timedOut: true };
    if (!(await slot())) return { failed: "too many names are being resolved at once", timedOut: false };
    try {
      return { addresses: await resolve(name) };
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (typeof code === "string" && NO_SUCH_NAME.has(code)) return { missing: true };
      const timeout = typeof code === "string" && TIMED_OUT.has(code);
      if (timeout) {
        timedOut.set(name, now());
        if (timedOut.size > RESOLVED_MAX) timedOut.delete(timedOut.keys().next().value ?? "");
      }
      return { failed: errorMessage(error), timedOut: timeout };
    } finally {
      free();
    }
  };
  return async (hostname) => {
    const name = hostname.replace(/\.$/, "").toLowerCase();
    const cached = answers.get(name);
    if (cached !== undefined && now() - cached.at < RESOLVED_TTL_MS) return cached.answer;
    const answer = ask(name);
    answers.delete(name);
    answers.set(name, { at: now(), answer });
    if (answers.size > RESOLVED_MAX) answers.delete(answers.keys().next().value ?? "");
    // A check that failed is never kept: the next request asks again.
    if ("failed" in (await answer) && answers.get(name)?.answer === answer) answers.delete(name);
    return answer;
  };
}

/** What a name's answer says of it: a refusal, or `undefined` when every address is public. */
function refusalOf(answer: NameAnswer): string | undefined {
  if ("missing" in answer) return undefined;
  if ("failed" in answer) return `could not be checked (${answer.failed})`;
  const classified = classifyAddresses(answer.addresses);
  if (classified.allowed || classified.refusal === "no-addresses") return undefined;
  return `resolves to ${describeAddressRefusal(classified.refusal)} (${classified.address})`;
}

/**
 * What a name resolves to that no approval opens, or `undefined`. A name the
 * resolver says does not exist is left to the browser, which cannot resolve
 * it either; any other failure — a timeout, a resolver error — refuses: an
 * address nobody could check is not opened.
 */
export async function resolvedAddressRefusal(hostname: string, resolve: ResolveHost): Promise<string | undefined> {
  return refusalOf(await createNameCache(resolve, Date.now)(hostname));
}

interface CheckOptions {
  readonly allowedHosts?: readonly string[];
  readonly resolveHost?: ResolveHost;
  readonly now?: () => number;
}

/**
 * The addresses with a port among the operator's `--browser-allow-host`
 * entries (`192.168.1.20:80`, `10.0.0.5:8080`, `[fd00::1]:443`): what a
 * confined browser may reach of the private network, where srt's proxy, not
 * this owner, resolves names.
 */
export function listedAddresses(allowedHosts: readonly string[]): readonly string[] {
  return allowedHosts.filter((entry) => {
    // An address with its port, as everywhere the private network opens: a bare one would open every port.
    const parsed = URL.parse(`http://${entry}/`);
    return parsed !== null && isIpLiteralHost(parsed.hostname) && /:\d+$/.test(entry);
  });
}

/** Where the egress proxy may connect for `host:port`: the addresses it checked, in order, or why not. */
export type EgressTarget = { readonly addresses: readonly string[] } | { readonly refused: string };

/**
 * Whether the operator listed exactly `host:port` (`nas.lan:80`,
 * `127.0.0.1:5173`, `[fd00::1]:8080`): what opens this machine or the private
 * network to the browser. A bare entry never does — it would open every port.
 */
export function listedExactly(host: string, port: number, allowedHosts: readonly string[]): boolean {
  const name = (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host).toLowerCase();
  const forms = isIpLiteralHost(name) && name.includes(":") ? [`[${name}]:${String(port)}`] : [`${name}:${String(port)}`];
  return allowedHosts.some((entry) => forms.includes(entry.toLowerCase().replace(/\.(?=:\d+$)/, "")));
}

/**
 * The egress proxy's check (`createEgressCheck`): the addresses to connect to
 * for `host:port` — checked once, connected to as they are, so a name that
 * answers differently the next time (DNS rebinding) is never asked again — or
 * why it may not be reached. A name must exist and resolve to public
 * addresses only. This machine or the private network is reached only for a
 * `host:port` the operator listed exactly.
 */
export function createEgressCheck(options: CheckOptions): (host: string, port: number) => Promise<EgressTarget> {
  const allowedHosts = options.allowedHosts ?? [];
  const names = createNameCache(options.resolveHost ?? systemResolve, options.now ?? Date.now);
  return async (host, port) => {
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host.replace(/\.$/, "");
    const opened = listedExactly(bare, port, allowedHosts);
    if (isIpLiteralHost(bare)) {
      const refusal = opened ? undefined : literalAddressRefusal(bare);
      return refusal === undefined ? { addresses: [bare] } : { refused: `${bare} is ${refusal}` };
    }
    if (!opened && LOOPBACK_NAME.test(bare)) return { refused: `${bare} is ${describeAddressRefusal("loopback")}` };
    const answer = await names(bare);
    if ("missing" in answer) return { refused: `${bare} does not resolve` };
    if ("failed" in answer) return { refused: `${bare} could not be checked (${answer.failed})` };
    if (!opened) {
      const refusal = refusalOf(answer);
      if (refusal !== undefined) return { refused: `${bare.toLowerCase()} ${refusal}` };
    }
    return answer.addresses.length === 0 ? { refused: `${bare} has no address` } : { addresses: [...answer.addresses] };
  };
}
