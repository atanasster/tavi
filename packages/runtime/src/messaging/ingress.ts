import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { BlockList, isIP, type Socket } from "node:net";

import { TaviError, type ChannelDescriptor, type ChannelRoute, type IngressRequest, type MessagingServicePort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

/**
 * The host's webhook ingress: one
 * listener for every channel that receives webhooks. A request names its
 * connection, `<prefix>/hooks/<connectionId>/<route>`, or for a provider that
 * delivers every account's events to one URL, `<prefix>/hooks/p/<providerId>/
 * <route>`. Before any connector code runs the host takes one of the address's
 * failures for the request (refusing it once they are spent, and giving it back
 * only once the request verifies), and holds the request to its route's body
 * cap, to the bytes one address may have in flight and to the bytes all
 * requests may have in flight; once the connector says the
 * request is its provider's, the host charges the connection's rate limit and
 * refuses a replay of a request it has seen. The connector only checks the
 * request is its provider's and turns it into events, which the host records.
 */
export interface ChannelIngressOptions {
  readonly messaging: Pick<MessagingServicePort, "ingressOf" | "connectionsOf" | "providerOf" | "ingest">;
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  /** The path the public address adds in front (`/tavi` for `https://mail.example.com/tavi`); requests are taken with or without it. */
  readonly pathPrefix?: string;
  /** Answers a request before the ingress looks at it (approval links); `true` when it did. */
  readonly before?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readonly now?: () => string;
  readonly rateBurst?: number;
  readonly ratePerSecond?: number;
  readonly log?: { error(message: string, fields?: Record<string, unknown>): void };
  /**
   * The replay cache and rate limits, kept across handlers: a handler made again
   * (a new public address) must not forget the signatures already seen.
   */
  readonly guards?: IngressGuards;
}

const DEFAULT_RATE_BURST = 60;
const DEFAULT_RATE_PER_SECOND = 5;
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000;
/** Replay keys remembered at most; the oldest are forgotten first once the expired ones are gone. */
const MAX_REMEMBERED = 50_000;
/**
 * Failed requests (a body over the cap, failed verification, a refusal for bytes in flight) one address may make, as a
 * burst refilled at the same number a minute. Each request takes one before its body is read and gets it back only once
 * it verifies, so no more than the burst of one address's unverified requests are ever being read at once, and once it
 * is spent the address's requests are refused before their body is read: forged posts cost the host a counter, and
 * never the shared rate limit a real delivery needs.
 */
const DEFAULT_FAILURE_BURST = 20;
const MINUTE_MS = 60_000;
/** Addresses whose failures are remembered at most; the least recently seen is forgotten first. */
const MAX_FAILURE_ADDRESSES = 4096;
/** Body bytes every request being read may hold at once; past it a request is answered 503 and the provider retries. */
const DEFAULT_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/**
 * Body bytes one address's requests may hold at once (an IPv6 address's /64, `failureKeyOf`): a quarter of the whole,
 * so one address alone never fills it for everyone else. Above any route's body cap, so one delivery always fits.
 */
const DEFAULT_MAX_IN_FLIGHT_BYTES_PER_ADDRESS = 16 * 1024 * 1024;

/**
 * The ingress HTTP server's limits: a client gets 15 s to send its headers and 60 s for the whole request, so a slow
 * body is cut off and its bytes released, at most 128 connections are open at once, and at most 16 of them from one
 * address (an IPv6 address's /64), so slow headers from one address never hold every slot. A peer on loopback or a
 * proxy the operator trusts carries everyone's requests, and is held only to the 128.
 */
export const INGRESS_SERVER_LIMITS = {
  headersTimeout: 15_000,
  requestTimeout: 60_000,
  maxConnections: 128,
  maxConnectionsPerAddress: 16,
} as const;

/**
 * Sets {@link INGRESS_SERVER_LIMITS} on the ingress's server, schedule webhooks' included: a connection past its
 * address's share is closed as it opens. `trustedProxy` names the proxies exempt from that share, beyond loopback.
 */
export function applyIngressServerLimits(
  server: Pick<Server, "headersTimeout" | "requestTimeout" | "maxConnections"> & Partial<Pick<Server, "on">>,
  trustedProxy: (address: string) => boolean = () => false,
): void {
  server.headersTimeout = INGRESS_SERVER_LIMITS.headersTimeout;
  server.requestTimeout = INGRESS_SERVER_LIMITS.requestTimeout;
  server.maxConnections = INGRESS_SERVER_LIMITS.maxConnections;
  if (typeof server.on !== "function") return;
  const open = new Map<string, number>();
  server.on("connection", (socket: Socket) => {
    const address = socket.remoteAddress ?? "";
    if (isLoopback(address) || trustedProxy(address)) return;
    const key = failureKeyOf(plainAddress(address));
    const count = open.get(key) ?? 0;
    if (count >= INGRESS_SERVER_LIMITS.maxConnectionsPerAddress) {
      socket.destroy();
      return;
    }
    open.set(key, count + 1);
    socket.once("close", () => {
      const left = (open.get(key) ?? 1) - 1;
      if (left > 0) open.set(key, left);
      else open.delete(key);
    });
  });
}

/** A token bucket per key: `take` is false once a key's burst is spent, until it refills. */
function createRateLimiter(burst: number, perSecond: number, now: () => number): (key: string) => boolean {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return (key) => {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: burst, last: at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.last) / 1000) * perSecond);
    bucket.last = at;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

/** Failed requests per key, as a burst refilled over a minute. */
export interface FailureBuckets {
  /** Whether the key's burst is spent, until it refills. */
  spent(key: string): boolean;
  /** Charges a failed request to the key; false when its burst was already spent. */
  charge(key: string): boolean;
  /** Gives back one charge (a request charged before it was read, that turned out good). */
  refund(key: string): void;
}

/**
 * A burst of `burst` failures per key, refilled at `burst` a minute. A bucket untouched for a minute is full again and
 * is dropped; each one touched moves last, so the stale ones are first, and past `maxKeys` the least recently touched
 * is forgotten (it starts full again, which takes failures from that many other addresses since it was last seen).
 */
export function createFailureBuckets(options: {
  readonly burst: number;
  readonly now: () => number;
  readonly maxKeys?: number;
}): FailureBuckets {
  const { burst, now } = options;
  const maxKeys = options.maxKeys ?? MAX_FAILURE_ADDRESSES;
  const buckets = new Map<string, { tokens: number; last: number }>();
  const bucketOf = (key: string): { tokens: number; last: number } => {
    const at = now();
    for (const [entry, bucket] of buckets) {
      if (at - bucket.last < MINUTE_MS) break;
      buckets.delete(entry);
    }
    const bucket = buckets.get(key) ?? { tokens: burst, last: at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.last) / MINUTE_MS) * burst);
    bucket.last = at;
    buckets.delete(key);
    buckets.set(key, bucket);
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return bucket;
  };
  return {
    spent: (key) => bucketOf(key).tokens < 1,
    charge(key) {
      const bucket = bucketOf(key);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    refund(key) {
      const bucket = bucketOf(key);
      bucket.tokens = Math.min(burst, bucket.tokens + 1);
    },
  };
}

/** Body bytes being read across every request: `take` is false once taking more would pass the cap. */
export interface ByteBudget {
  take(bytes: number): boolean;
  release(bytes: number): void;
  inFlight(): number;
}

/** The ingress's {@link ByteBudget}, with a share per address. */
export interface IngressByteBudget extends ByteBudget {
  /** A budget whose bytes count against both `key`'s share and the whole: `take` is false once either would pass its cap. */
  forAddress(key: string): ByteBudget;
}

function createByteBudget(maxBytes: number, maxPerAddress: number): IngressByteBudget {
  let held = 0;
  const byAddress = new Map<string, number>();
  const take = (bytes: number): boolean => {
    if (held + bytes > maxBytes) return false;
    held += bytes;
    return true;
  };
  const release = (bytes: number): void => {
    held = Math.max(0, held - bytes);
  };
  return {
    take,
    release,
    inFlight: () => held,
    forAddress: (key) => ({
      take(bytes) {
        const mine = byAddress.get(key) ?? 0;
        if (mine + bytes > maxPerAddress || !take(bytes)) return false;
        byAddress.set(key, mine + bytes);
        return true;
      },
      release(bytes) {
        const left = (byAddress.get(key) ?? 0) - bytes;
        if (left > 0) byAddress.set(key, left);
        else byAddress.delete(key);
        release(bytes);
      },
      inFlight: () => byAddress.get(key) ?? 0,
    }),
  };
}

/** An address as the socket reports it, compared plainly: an IPv4-mapped IPv6 address as IPv4, with no zone. */
function plainAddress(address: string): string {
  const unzoned = address.split("%")[0] ?? "";
  const v4 = unzoned.toLowerCase().startsWith("::ffff:") ? unzoned.slice("::ffff:".length) : unzoned;
  return isIP(v4) === 4 ? v4 : unzoned;
}

function isLoopback(address: string): boolean {
  const plain = plainAddress(address);
  return plain === "::1" || (isIP(plain) === 4 && plain.startsWith("127."));
}

/**
 * Whether `entry` names a trusted proxy: one address (`192.0.2.10`, `2001:db8::5`) or a CIDR range (`10.0.0.0/8`,
 * `2001:db8::/32`).
 */
export function isTrustedProxyEntry(entry: string): boolean {
  const [address = "", prefix, extra] = entry.split("/");
  const family = isIP(address);
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * The reverse proxies, besides one on this machine, whose `X-Forwarded-For` the ingress believes: the operator's
 * (`tavi channels ingress --trusted-proxies`), set again whenever the listener's settings are read.
 */
export interface TrustedProxies {
  /** Replaces the list; an entry {@link isTrustedProxyEntry} refuses is skipped. */
  set(entries: readonly string[]): void;
  /** Whether a socket's peer is one of them. */
  trusts(address: string): boolean;
}

export function createTrustedProxies(entries: readonly string[] = []): TrustedProxies {
  let list = new BlockList();
  let any = false;
  const proxies: TrustedProxies = {
    set(next) {
      const built = new BlockList();
      let count = 0;
      for (const entry of next) {
        if (!isTrustedProxyEntry(entry)) continue;
        const [address = "", prefix] = entry.split("/");
        const plain = plainAddress(address);
        const type = isIP(plain) === 4 ? "ipv4" : "ipv6";
        if (prefix === undefined) built.addAddress(plain, type);
        else built.addSubnet(plain, Number(prefix), type);
        count += 1;
      }
      list = built;
      any = count > 0;
    },
    trusts(address) {
      if (!any) return false;
      const plain = plainAddress(address);
      const family = isIP(plain);
      return family !== 0 && list.check(plain, family === 4 ? "ipv4" : "ipv6");
    },
  };
  proxies.set(entries);
  return proxies;
}

/**
 * The address a request came from, for its failure bucket: the socket's, or, only when the socket is loopback (a
 * reverse proxy or tunnel on this machine) or a proxy the operator trusts, the last `X-Forwarded-For` entry, the one
 * that proxy added. A header sent straight to the listener from anywhere else is never believed, so spoofed addresses
 * cannot spread one caller's failures across many buckets, nor charge another's.
 */
export function clientAddressOf(req: IncomingMessage, trustedProxy: (address: string) => boolean = () => false): string {
  const socket = req.socket?.remoteAddress ?? "";
  if (!isLoopback(socket) && !trustedProxy(socket)) return socket;
  const header = req.headers["x-forwarded-for"];
  const entries = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const last = entries.at(-1);
  return last !== undefined && isIP(last) !== 0 ? last : socket;
}

/**
 * The key an address's failures are counted under: an IPv6 address by its /64, since one host is commonly given a whole
 * /64 and could otherwise take a fresh burst from each address in it; any other address as it is.
 */
export function failureKeyOf(address: string): string {
  const plain = (address.split("%")[0] ?? "").toLowerCase();
  if (isIP(plain) !== 6 || plain.startsWith("::ffff:")) return address;
  const groupsOf = (part: string): string[] =>
    part === "" ? [] : part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
  const [before = "", after] = plain.split("::");
  const head = groupsOf(before);
  const tail = after === undefined ? [] : groupsOf(after);
  const groups = [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** The ingress's replay cache, rate limits, failure buckets and in-flight body bytes. */
export interface IngressGuards {
  /** The shared rate limit per connection (`p:<providerId>` for a provider's URL), charged only for a verified request. */
  readonly rate: (key: string) => boolean;
  readonly replays: { claim(key: string, ttlMs: number): boolean | "full"; release(key: string): void };
  /** Failed channel requests per client address. */
  readonly failures: FailureBuckets;
  /** Body bytes being read, channel deliveries' and schedule webhooks' alike, in all and per client address. */
  readonly bodyBytes: IngressByteBudget;
  /** The proxies whose `X-Forwarded-For` names the client, beyond one on loopback: channel deliveries' and schedule webhooks'. */
  readonly trustedProxies: TrustedProxies;
}

export function createIngressGuards(
  options: {
    readonly now?: () => string;
    readonly rateBurst?: number;
    readonly ratePerSecond?: number;
    readonly failureBurst?: number;
    readonly maxInFlightBytes?: number;
    readonly maxInFlightBytesPerAddress?: number;
    readonly trustedProxies?: readonly string[];
  } = {},
): IngressGuards {
  const now = options.now ?? nowTimestamp;
  const nowMs = (): number => new Date(now()).getTime();
  return {
    rate: createRateLimiter(options.rateBurst ?? DEFAULT_RATE_BURST, options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND, nowMs),
    replays: createReplayCache(nowMs),
    failures: createFailureBuckets({ burst: options.failureBurst ?? DEFAULT_FAILURE_BURST, now: nowMs }),
    bodyBytes: createByteBudget(
      options.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
      options.maxInFlightBytesPerAddress ?? DEFAULT_MAX_IN_FLIGHT_BYTES_PER_ADDRESS,
    ),
    trustedProxies: createTrustedProxies(options.trustedProxies),
  };
}

/**
 * Replay keys seen, each until it may be forgotten; `claim` is false for one
 * already seen, and `"full"` when every key it holds is still live — never
 * forgetting one early, which would let it be replayed.
 */
function createReplayCache(now: () => number): IngressGuards["replays"] {
  const seen = new Map<string, number>();
  return {
    claim(key, ttlMs) {
      const at = now();
      for (const [entry, expiresAt] of seen) {
        if (expiresAt > at) break;
        seen.delete(entry);
      }
      const expiresAt = seen.get(key);
      if (expiresAt !== undefined && expiresAt > at) return false;
      if (seen.size >= MAX_REMEMBERED) return "full";
      // Re-inserted, so the oldest claims stay first for the prune above (with
      // different TTLs that is near enough: an expired key past a live one is
      // dropped on a later prune, and `claim` checks expiry itself).
      seen.delete(key);
      seen.set(key, at + ttlMs);
      return true;
    },
    release(key) {
      seen.delete(key);
    },
  };
}

function respond(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.end(body);
}

/**
 * The body, or `"too-large"` once it passes `maxBytes`, or `"busy"` once `budget` (the bytes every request may have in
 * flight) would pass its cap: the connection is then torn down, not left half-read, or with `overflow: "pause"` left
 * paused, for the caller to answer before it closes it. The bytes taken from `budget` are given back however the read
 * ends — a body, a refusal, an error or a connection closed (a slow body cut off by the server's request timeout).
 */
export function readBody(
  req: IncomingMessage,
  maxBytes: number,
  overflow: "destroy" | "pause" = "destroy",
  budget?: ByteBudget,
): Promise<Uint8Array | "too-large" | "busy"> {
  let taken = 0;
  const read = new Promise<Uint8Array | "too-large" | "busy">((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const refuse = (answer: "too-large" | "busy"): void => {
      settled = true;
      if (overflow === "pause") req.pause();
      else req.destroy();
      resolve(answer);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) return refuse("too-large");
      if (budget !== undefined) {
        if (!budget.take(chunk.byteLength)) return refuse("busy");
        taken += chunk.byteLength;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("request closed before the body was fully received"));
    });
  });
  return budget === undefined ? read : read.finally(() => budget.release(taken));
}

type Target =
  | { readonly scope: "connection"; readonly connectionId: string; readonly route: string }
  | { readonly scope: "provider"; readonly providerId: string; readonly route: string };

function targetOf(path: string, prefix: string | undefined): Target | undefined {
  const local = prefix !== undefined && prefix !== "" && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
  try {
    const provider = /^\/hooks\/p\/([^/]+)\/([^/]+)\/?$/.exec(local);
    if (provider !== null)
      return { scope: "provider", providerId: decodeURIComponent(provider[1]!), route: decodeURIComponent(provider[2]!) };
    const connection = /^\/hooks\/([^/]+)\/([^/]+)\/?$/.exec(local);
    if (connection !== null)
      return { scope: "connection", connectionId: decodeURIComponent(connection[1]!), route: decodeURIComponent(connection[2]!) };
  } catch {
    // A malformed escape names nothing: not found, like any other unknown path.
  }
  return undefined;
}

export function createChannelIngress(options: ChannelIngressOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = options.now ?? nowTimestamp;
  const { rate, replays, failures, bodyBytes, trustedProxies } =
    options.guards ??
    createIngressGuards({
      now,
      ...(options.rateBurst === undefined ? {} : { rateBurst: options.rateBurst }),
      ...(options.ratePerSecond === undefined ? {} : { ratePerSecond: options.ratePerSecond }),
    });

  const routeOf = (providerId: string | undefined, name: string, scope: ChannelRoute["scope"], method: string): ChannelRoute | undefined =>
    providerId === undefined
      ? undefined
      : options
          .descriptorOf(providerId)
          ?.ingress?.find((route) => route.name === name && route.scope === scope && (route.methods as readonly string[]).includes(method));

  return async (req, res) => {
    if (options.before !== undefined && (await options.before(req, res))) return;
    const url = new URL(req.url ?? "/", "http://ingress.invalid");
    const method = req.method === "GET" || req.method === "POST" ? req.method : undefined;
    if (method === undefined) return respond(res, 405, "method not allowed");
    const target = targetOf(url.pathname, options.pathPrefix);
    if (target === undefined) return respond(res, 404, "not found");
    const providerId = target.scope === "provider" ? target.providerId : options.messaging.providerOf(target.connectionId);
    const route = routeOf(providerId, target.route, target.scope, method);
    if (route === undefined || providerId === undefined) return respond(res, 404, "not found");
    // Each request takes one of its address's failures before any body is read, given back only once it verifies: an
    // address's unverified requests in flight never outnumber its burst, and once it is spent the address is refused
    // before any body is read. A flood costs a counter, not a buffer, and never the shared rate limit, which only a
    // verified request is charged.
    const address = failureKeyOf(clientAddressOf(req, trustedProxies.trusts));
    if (!failures.charge(address)) return respond(res, 429, "too many requests");
    let body: Uint8Array | "too-large" | "busy";
    try {
      body = await readBody(req, route.maxBodyBytes, "pause", bodyBytes.forAddress(address));
    } catch {
      return respond(res, 400, "failed to read request body");
    }
    if (body === "busy" || body === "too-large") {
      // The rest is not read: the connection closes once the refusal is sent.
      res.setHeader("connection", "close");
      res.on("finish", () => req.destroy());
      // Too many bytes in flight, the address's or every request's: the provider retries later, and the failure stays taken.
      if (body === "busy") return respond(res, 503, "busy");
      return respond(res, 413, "request body too large");
    }
    const request: IngressRequest = {
      method,
      route: route.name,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]),
      ),
      query: Object.fromEntries(url.searchParams),
      rawBody: body,
    };
    let connectionId: string | undefined;
    let opened: ReturnType<typeof options.messaging.ingressOf>;
    let verified: Awaited<ReturnType<NonNullable<typeof opened>["ingress"]["verify"]>> | undefined;
    if (target.scope === "provider") {
      const connections = options.messaging.connectionsOf(providerId);
      const any = connections[0] === undefined ? undefined : options.messaging.ingressOf(connections[0].connectionId);
      const chosen = any?.ingress.connectionFor?.(request, connections);
      // Only one of this provider's own connections: never another channel's, whatever the connector answers.
      connectionId = connections.some((connection) => connection.connectionId === chosen) ? chosen : undefined;
      // A request that names none (a provider's verification handshake) is the connection whose own check accepts it.
      if (connectionId === undefined && chosen === undefined) {
        for (const candidate of connections) {
          const candidateIngress = options.messaging.ingressOf(candidate.connectionId);
          const answer =
            candidateIngress === undefined ? undefined : await candidateIngress.ingress.verify(request, candidateIngress.context);
          if (answer?.ok === true) {
            connectionId = candidate.connectionId;
            verified = answer;
            break;
          }
        }
        // Open connections, and none of them accepts it: refused as any request failing verification is.
        if (connectionId === undefined && connections.length > 0) return respond(res, 403, "verification failed");
      }
      // Acknowledged, so the provider does not retry an event for no open connection forever.
      if (connectionId === undefined) return respond(res, 200, "ok");
    } else connectionId = target.connectionId;
    opened = options.messaging.ingressOf(connectionId);
    if (opened === undefined) return respond(res, 404, "not found");
    verified ??= await opened.ingress.verify(request, opened.context);
    if (!verified.ok) return respond(res, 403, "verification failed");
    // The provider's own request: its failure is given back.
    failures.refund(address);
    // Charged once, for the connection that verified, under the key of the URL it came in on.
    if (!rate(target.scope === "provider" ? `p:${target.providerId}` : target.connectionId)) return respond(res, 429, "too many requests");
    const replayKey = verified.replayKey === undefined ? undefined : `${connectionId}\u0000${verified.replayKey}`;
    const claimed = replayKey === undefined ? true : replays.claim(replayKey, verified.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS);
    // Too many live signatures to remember another: the provider retries later, and none is forgotten early.
    if (claimed === "full") return respond(res, 503, "busy");
    // A replay is a failed request, charged again to its address.
    if (!claimed) {
      failures.charge(address);
      return respond(res, 403, "already received");
    }
    let handled: Awaited<ReturnType<typeof opened.ingress.handle>>;
    try {
      handled = await opened.ingress.handle(request, opened.context);
    } catch (error) {
      // A malformed request stays refused; any other failure was not the
      // request's, so the provider's retry of it must be taken.
      if (TaviError.from(error).code === "INVALID_INPUT") return respond(res, 400, "invalid request");
      if (replayKey !== undefined) replays.release(replayKey);
      throw error;
    }
    // Only the verified connection's events: one a connector names for another connection is never taken as its.
    const own = handled.events.filter((event) => event.connectionId === connectionId);
    if (own.length !== handled.events.length)
      options.log?.error("ingress: a connector named another connection in its events; they were dropped", {
        connectionId,
        dropped: handled.events.length - own.length,
      });
    try {
      for (const event of own) await options.messaging.ingest(event);
    } catch (error) {
      // Recorded, but its admission failed: the provider retries with the same
      // request, which must not be refused as a replay of itself.
      if (replayKey !== undefined) replays.release(replayKey);
      options.log?.error("ingress: an event was recorded but its processing failed", { connectionId, error });
      return respond(res, 502, "recorded but processing failed");
    }
    const answer = handled.response;
    return answer === undefined ? respond(res, 200, "ok") : respond(res, answer.status, answer.body, answer.contentType);
  };
}
