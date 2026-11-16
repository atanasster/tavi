import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/client";
import { TaviError } from "@tavi/contracts";
import { addressTargets, classifyIpAddress, describeAddressRefusal, pinnedLookup, type AddressRefusal } from "@tavi/runtime";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * The guarded fetch every request to a remote MCP server makes, OAuth
 * discovery, token and registration requests included:
 *
 * - https only; plain http only to a private or loopback address, with `lan`;
 * - no redirects;
 * - the name resolved once, and the connection pinned to that address while
 *   TLS still verifies the name;
 * - private, loopback, link-local and carrier-grade NAT addresses only with
 *   `lan`; the cloud metadata addresses never; every other special range never;
 * - no ambient proxy: the dispatcher connects directly, whatever the
 *   environment says.
 *
 * The per-message cap is applied on top (`cappedFetch`).
 */

/** Addresses a server is never reached at, `lan` or not: the cloud metadata services. */
const METADATA_ADDRESSES: ReadonlySet<string> = new Set(["169.254.169.254", "fd00:ec2:0:0:0:0:0:254"]);

/** Refusals `lan` lifts: a server on the operator's own network. */
const LAN_RANGES: ReadonlySet<AddressRefusal> = new Set(["private", "loopback", "link-local", "carrier-grade-nat", "shared-address-space"]);

export interface GuardedFetchOptions {
  /** The server's `network.lan`: private and loopback addresses, and plain http only to them. */
  readonly lan: boolean;
  /** Resolves a name to its addresses (tests); the system resolver otherwise. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /**
   * A redirect is answered to the caller, who follows it through this fetch
   * again (a registry download); otherwise a redirect is refused.
   */
  readonly manualRedirects?: boolean;
}

/** Why `address` may not be dialed under this policy, or `undefined`. */
export function addressProblem(address: string, lan: boolean): string | undefined {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // Every spelling: an IPv4-mapped or NAT64 form of a metadata address is the metadata address.
  if (addressTargets(bare).some((target) => METADATA_ADDRESSES.has(target)))
    return `${bare} is a cloud metadata address, which is never reached`;
  const refusal = classifyIpAddress(bare);
  if (refusal === undefined) return undefined;
  if (lan && LAN_RANGES.has(refusal)) return undefined;
  return `${bare} is ${describeAddressRefusal(refusal)}${LAN_RANGES.has(refusal) ? "; a server on your own network needs network.lan (--lan)" : ""}`;
}

const systemResolve = async (hostname: string): Promise<readonly string[]> =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * The address a request to `url` dials, after every check: the name resolved
 * once, every answer classified, a mixed answer refused (a public half would
 * leave a retry free to dial the other).
 */
export async function guardedAddress(url: URL, options: GuardedFetchOptions): Promise<string> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TaviError("NOT_AUTHORIZED", `${url.protocol} is not a web address`);
  if (url.username !== "" || url.password !== "")
    throw new TaviError("NOT_AUTHORIZED", "an MCP server's address must not carry credentials");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const addresses = isIP(host) !== 0 ? [host] : await (options.resolve ?? systemResolve)(host);
  if (addresses.length === 0) throw new TaviError("UNAVAILABLE", `${host} resolved to no address`);
  for (const address of addresses) {
    const problem = addressProblem(address, options.lan);
    if (problem !== undefined) throw new TaviError("NOT_AUTHORIZED", `${host} resolved to ${problem}`);
  }
  const address = addresses[0] as string;
  // Plain http only to the operator's own network: a public server is https.
  if (url.protocol === "http:" && classifyIpAddress(address) === undefined)
    throw new TaviError("NOT_AUTHORIZED", `${host} is a public address, which is reached over https only`);
  if (url.protocol === "http:" && !options.lan)
    throw new TaviError("NOT_AUTHORIZED", "plain http is allowed only to a server on your own network (network.lan)");
  return address;
}

/** A fetch under the guard; each request resolves, checks and pins on its own. */
export function guardedFetch(options: GuardedFetchOptions): FetchLike {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    const address = await guardedAddress(url, options);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) as never }, connections: 1 });
    try {
      const response = await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        redirect: options.manualRedirects === true ? "manual" : "error",
        dispatcher,
      });
      // A status that has no body (204, 304, …) must be built without one.
      const body = [101, 204, 205, 304].includes(response.status) ? null : response.body;
      // The dispatcher closes once its response has been read (or abandoned).
      const closing =
        body === null ? undefined : body.pipeThrough(new TransformStream({ flush: () => void dispatcher.close().catch(() => undefined) }));
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      if (closing === undefined) void dispatcher.close().catch(() => undefined);
      return new Response((closing as ReadableStream<Uint8Array> | undefined) ?? null, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
      });
    } catch (error) {
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      void dispatcher.destroy().catch(() => undefined);
      throw error;
    }
  };
}
