import { expect, it, vi } from "vitest";
import {
  createPublicFetchProvider,
  MAX_FETCH_BYTES,
  assertPublicDestination,
  hostAllowedWithPort,
  httpsPinnedTransport,
  pinnedLookup,
  pinnedRequestOptions,
  publicFetch,
  type FetchExchangeRequest,
  type FetchExchangeResponse,
  type FetchTransportPort,
} from "@tavi/runtime";
import { classifyAddresses } from "@tavi/runtime";

/**
 * The SSRF suite for `web_fetch`.
 *
 * No real network: the resolver and the transport are injected, so every row is a
 * table of attacks rather than a hope. Each guard has a case that fails if the
 * guard is removed:
 *
 *  - address classes      → `classifyAddresses` rows (packages/runtime address-guard suite)
 *  - rebinding            → the resolver is called exactly once and the transport
 *                           receives the address that was validated
 *  - redirects            → private host, scheme downgrade, hop cap
 *  - response bounds      → encoded cap, decompression bomb, content-type gate
 *  - deadline             → a transport that never produces bytes
 *  - policy               → mode matrix, IP literal, userinfo, mixed answer
 *  - positive control     → an allowlisted host really is retrieved
 */

type Script = { status: number; headers?: Record<string, string>; body?: string; hang?: boolean };

function fakeTransport(
  script: (request: FetchExchangeRequest, index: number) => Script,
  calls: FetchExchangeRequest[] = [],
): FetchTransportPort {
  return {
    exchange: async (request) => {
      const index = calls.length;
      calls.push(request);
      const answer = script(request, index);
      const bytes = new TextEncoder().encode(answer.body ?? "");
      const chunks: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          if (answer.hang === true) {
            // A real `IncomingMessage` is destroyed by the abort signal; the fake
            // has to honour it too, or the deadline and cancellation paths could
            // not be observed at all.
            await new Promise<never>((_, reject) => {
              if (request.signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            return;
          }
          yield bytes;
        },
      };
      const response: FetchExchangeResponse = { status: answer.status, headers: answer.headers ?? {}, chunks };
      return response;
    },
  };
}

const resolving = (addresses: readonly string[], counter = { calls: 0 }) => ({
  resolve: async () => {
    counter.calls += 1;
    return addresses;
  },
  counter,
});

const html = (body: string, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});

it.each(["text/html", "text/plain"])("returns the plain fetch contract for %s through the guarded transport", async (contentType) => {
  const calls: FetchExchangeRequest[] = [];
  const provider = createPublicFetchProvider({
    networkMode: "custom_hosts",
    allowedHosts: ["news.example.com"],
    resolve: async () => ["93.184.216.34"],
    transport: fakeTransport(() => ({ status: 200, headers: { "content-type": contentType }, body: "hello" }), calls),
  });
  expect(provider.available()).toBe(true);
  expect(await provider.fetch({ url: "https://news.example.com/page" })).toEqual({
    url: "https://news.example.com/page",
    statusCode: 200,
    body: { kind: contentType === "text/html" ? "html" : "text", content: "hello" },
    truncated: false,
  });
  expect(calls[0]?.address).toBe("93.184.216.34");
  await expect(provider.fetch({ url: "https://other.example/page" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  expect(calls).toHaveLength(1);
});

it("retrieves a public page through the allowlisted host and reports the dialed address", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve, counter } = resolving(["93.184.216.34"]);
  const result = await publicFetch(
    {
      networkMode: "custom_hosts",
      allowedHosts: ["news.example.com"],
      resolve,
      transport: fakeTransport(() => html("<p>Model One released.</p>"), calls),
    },
    { url: "https://news.example.com/release" },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: 200,
    contentType: "text/html",
    address: "93.184.216.34",
    addressClass: "public",
    redirects: [],
    truncated: false,
  });
  expect(result.body).toContain("Model One released.");
  expect(counter.calls).toBe(1);
  // The socket destination is the validated address, not a name the transport
  // would resolve again (a mocked response cannot prove this).
  expect(calls[0]?.address).toBe("93.184.216.34");
  expect(calls[0]?.url.hostname).toBe("news.example.com");
});

it("pins the socket to the validated address while leaving the hostname for TLS", () => {
  const lookup = pinnedLookup("93.184.216.34");
  const modern: unknown[] = [];
  lookup("news.example.com", { all: true }, (...args: unknown[]) => modern.push(...args));
  expect(modern).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  const legacy: unknown[] = [];
  lookup("news.example.com", {}, (...args: unknown[]) => legacy.push(...args));
  expect(legacy).toEqual([null, "93.184.216.34", 4]);
  const six: unknown[] = [];
  pinnedLookup("2606:4700:4700::1111")("news.example.com", {}, (...args: unknown[]) => six.push(...args));
  expect(six).toEqual([null, "2606:4700:4700::1111", 6]);
  // The transport's *wiring*, which is the part a mocked exchange cannot show:
  // the socket destination is pinned while TLS keeps verifying the hostname.
  const options = pinnedRequestOptions(
    new URL("https://news.example.com/page"),
    "93.184.216.34",
    { accept: "text/html" },
    new AbortController().signal,
  );
  expect(options).toMatchObject({ hostname: "news.example.com", servername: "news.example.com", port: 443, method: "GET", agent: false });
  const wired: unknown[] = [];
  (options["lookup"] as (h: string, o: unknown, cb: (...args: unknown[]) => void) => void)("news.example.com", {}, (...args: unknown[]) =>
    wired.push(...args),
  );
  expect(wired).toEqual([null, "93.184.216.34", 4]);
  const explicit = pinnedRequestOptions(new URL("https://news.example.com:443/page"), "93.184.216.34", {}, new AbortController().signal);
  expect(explicit["port"]).toBe(443);
  expect(httpsPinnedTransport()).toHaveProperty("exchange");
});

it("does not resolve twice, so a rebinding answer never wins", async () => {
  const addresses = { calls: 0 };
  const calls: FetchExchangeRequest[] = [];
  const resolve = async (): Promise<readonly string[]> => {
    addresses.calls += 1;
    return addresses.calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const result = await publicFetch(
    { networkMode: "open_web", resolve, transport: fakeTransport(() => html("<p>ok</p>"), calls) },
    { url: "https://rebind.example.com/" },
    new AbortController().signal,
  );
  expect(addresses.calls).toBe(1);
  expect(calls[0]?.address).toBe("93.184.216.34");
  expect(result.address).toBe("93.184.216.34");
});

it.each([
  ["loopback", "127.0.0.1"],
  ["private", "10.1.2.3"],
  ["link-local metadata", "169.254.169.254"],
  ["carrier-grade NAT", "100.64.0.1"],
  ["IPv6 loopback", "::1"],
  ["IPv6 unique-local", "fd00::1"],
  ["IPv6 link-local", "fe80::1"],
  ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
])("refuses a host that resolves to %s before any exchange", async (_label, address) => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving([address]);
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope"), calls) },
      { url: "https://attacker.example.com/" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  expect(calls).toHaveLength(0);
});

it("refuses an answer that mixes a public and a non-public address", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34", "127.0.0.1"]);
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope"), calls) },
      { url: "https://mixed.example.com/" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/loopback/);
  expect(calls).toHaveLength(0);
  // The refusal is the classification, not a lucky pick of the first address.
  expect(classifyAddresses(["127.0.0.1", "93.184.216.34"])).toMatchObject({ allowed: false, refusal: "loopback" });
});

it.each([
  ["an IP literal", "https://93.184.216.34/", "custom_hosts"],
  ["userinfo", "https://user:secret@news.example.com/", "open_web"],
  ["plain http", "http://news.example.com/", "open_web"],
])("refuses %s", async (_label, url, mode) => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34"]);
  await expect(
    publicFetch(
      {
        networkMode: mode as "open_web" | "custom_hosts",
        allowedHosts: ["news.example.com"],
        resolve,
        transport: fakeTransport(() => html("nope"), calls),
      },
      { url },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  expect(calls).toHaveLength(0);
});

it.each([
  ["allowlist", "https://other.example.com/", "NOT_AUTHORIZED"],
  ["custom_hosts", "https://other.example.com/", "NOT_AUTHORIZED"],
  ["primary_sources", "https://random-blog.example/", "NOT_AUTHORIZED"],
  ["primary_sources", "https://openai.com/news", undefined],
  ["open_web", "https://random-blog.example/", undefined],
])("honours the %s mode for %s", async (mode, url, code) => {
  const { resolve } = resolving(["93.184.216.34"]);
  const run = publicFetch(
    {
      networkMode: mode as "allowlist" | "custom_hosts" | "primary_sources" | "open_web",
      allowedHosts: ["news.example.com"],
      resolve,
      transport: fakeTransport(() => html("<p>ok</p>")),
    },
    { url },
    new AbortController().signal,
  );
  if (code === undefined) await expect(run).resolves.toMatchObject({ status: 200 });
  else await expect(run).rejects.toMatchObject({ code });
});

it("re-validates every redirect hop, refuses a downgrade, and caps the chain", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34"]);
  const record = (_from: string, to: string) => ({ status: 302, headers: { location: to, "content-type": "text/html" }, body: "" });

  const chain = await publicFetch(
    {
      networkMode: "open_web",
      resolve,
      transport: fakeTransport(
        (request) =>
          request.url.pathname === "/start"
            ? record(request.url.toString(), "/middle")
            : request.url.pathname === "/middle"
              ? record(request.url.toString(), "/final")
              : html("<p>arrived</p>"),
        calls,
      ),
    },
    { url: "https://news.example.com/start" },
    new AbortController().signal,
  );
  expect(chain.body).toContain("arrived");
  expect(chain.redirects.map((hop) => hop.to)).toEqual(["https://news.example.com/middle", "https://news.example.com/final"]);
  expect(chain.redirects.every((hop) => hop.address === "93.184.216.34")).toBe(true);

  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(() => ({ status: 302, headers: { location: "http://news.example.com/down" } })),
      },
      { url: "https://news.example.com/start" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });

  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport((request) => ({
          status: 302,
          headers: { location: `https://news.example.com/${Number(request.url.pathname.slice(1)) + 1}` },
        })),
      },
      { url: "https://news.example.com/0" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/redirects/);
});

it("refuses a redirect to a host that resolves to a private address", async () => {
  const calls: FetchExchangeRequest[] = [];
  const resolve = async (hostname: string): Promise<readonly string[]> =>
    hostname === "news.example.com" ? ["93.184.216.34"] : ["169.254.169.254"];
  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(
          (request) =>
            request.url.hostname === "news.example.com"
              ? { status: 302, headers: { location: "https://metadata.example.com/latest" } }
              : html("secret"),
          calls,
        ),
      },
      { url: "https://news.example.com/start" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/link-local/);
  expect(calls).toHaveLength(1);
});

it("refuses a body over the encoded cap, and a decompression bomb", async () => {
  const { resolve } = resolving(["93.184.216.34"]);
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, maxBytes: 64, transport: fakeTransport(() => html("x".repeat(200))) },
      { url: "https://news.example.com/big" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/exceeded the 64-byte fetch limit/);

  const { gzipSync } = await import("node:zlib");
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x41));
  const transport: FetchTransportPort = {
    exchange: async () => ({
      status: 200,
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      chunks: {
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array(bomb);
        },
      },
    }),
  };
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, maxDecodedBytes: 1024, transport },
      { url: "https://news.example.com/bomb" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/decoded within the 1024-byte limit/);
});

it("refuses a disallowed content type and an unsupported encoding", async () => {
  const { resolve } = resolving(["93.184.216.34"]);
  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(() => ({ status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" })),
      },
      { url: "https://news.example.com/report.pdf" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/content-type application\/pdf/);

  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(() => ({ status: 200, headers: { "content-type": "text/html", "content-encoding": "br" }, body: "x" })),
      },
      { url: "https://news.example.com/br" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/content-encoding br is not supported/);
});

it("times out a transport that never produces bytes, and cancels on the caller's signal", async () => {
  const { resolve } = resolving(["93.184.216.34"]);
  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        timeoutMs: 20,
        transport: fakeTransport(() => ({ status: 200, headers: { "content-type": "text/html" }, hang: true })),
      },
      { url: "https://news.example.com/slow" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });

  const controller = new AbortController();
  const pending = publicFetch(
    {
      networkMode: "open_web",
      resolve,
      timeoutMs: 5_000,
      transport: fakeTransport(() => ({ status: 200, headers: { "content-type": "text/html" }, hang: true })),
    },
    { url: "https://news.example.com/slow" },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});

it("sends no credential, cookie or caller header, and only GET", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34"]);
  await publicFetch(
    { networkMode: "open_web", resolve, transport: fakeTransport(() => html("<p>ok</p>"), calls) },
    { url: "https://news.example.com/page" },
    new AbortController().signal,
  );
  const headers = calls[0]!.headers;
  expect(Object.keys(headers).sort()).toEqual(["accept", "accept-encoding", "user-agent"]);
  expect(headers["accept-encoding"]).toBe("identity");
  expect(JSON.stringify(headers)).not.toMatch(/cookie|authorization|credential/i);
  // The transport is asked for an address and a URL only: there is no method and
  // no body to smuggle one through.
  expect(Object.keys(calls[0]!).sort()).toEqual(["address", "headers", "signal", "url"]);
});

it("refuses an oversized response even when the transport yields it in chunks", async () => {
  const { resolve } = resolving(["93.184.216.34"]);
  const chunk = new Uint8Array(40);
  const transport: FetchTransportPort = {
    exchange: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      chunks: {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 10; index += 1) yield chunk;
        },
      },
    }),
  };
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, maxBytes: 100, transport },
      { url: "https://news.example.com/chunked" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/exceeded the 100-byte fetch limit/);
});

it("keeps the default encoded cap at the documented 2 MiB", async () => {
  expect(MAX_FETCH_BYTES).toBe(2 * 1024 * 1024);
});

it("surfaces a resolver failure as an unavailable fetch, not an authorization one", async () => {
  const resolve = vi.fn(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope")) },
      { url: "https://missing.example.com/" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

it("types a resolver failure as unavailable on the shared guard too, not as an authority refusal", async () => {
  // The legacy `http.request` path shares this helper, and a DNS failure is not a
  // grant decision: the durable ledger records a denial only for
  // `NOT_AUTHORIZED`, so a resolver failure must not be one.
  const unresolvable = {
    options: {
      publicFetch: {
        resolve: async (): Promise<readonly string[]> => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      },
    },
  };
  await expect(assertPublicDestination(unresolvable, "https://missing.example.com/")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  // A real policy refusal keeps its own code, so the two remain distinguishable.
  const loopback = { options: { publicFetch: { resolve: async (): Promise<readonly string[]> => ["127.0.0.1"] } } };
  await expect(assertPublicDestination(loopback, "https://loopback.example.com/")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

it("settles at the deadline while the resolver is still in flight", async () => {
  // `dns.lookup` accepts no signal, so an in-flight lookup cannot be cancelled;
  // the deadline has to race it anyway, or the step most likely to hang is the
  // one step the deadline does not bound.
  const started = Date.now();
  const resolve = (): Promise<readonly string[]> =>
    new Promise((settle) => {
      setTimeout(() => settle(["93.184.216.34"]), 1_000);
    });
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, timeoutMs: 50, transport: fakeTransport(() => html("nope")) },
      { url: "https://slow-dns.example.com/" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(Date.now() - started).toBeLessThan(600);
});

it("stops waiting for a resolver that never answers when the caller cancels", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = publicFetch(
    {
      networkMode: "open_web",
      resolve: () => new Promise<readonly string[]>(() => {}),
      timeoutMs: 60_000,
      transport: fakeTransport(() => html("nope")),
    },
    { url: "https://wedged-dns.example.com/" },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(Date.now() - started).toBeLessThan(600);
});

it("cancels while the resolver is still running", async () => {
  const controller = new AbortController();
  const resolve = async (): Promise<readonly string[]> => {
    await new Promise<void>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return ["93.184.216.34"];
  };
  const pending = publicFetch(
    { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope")) },
    { url: "https://slow-dns.example.com/" },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});

it("cancels while the transport is connecting", async () => {
  const controller = new AbortController();
  const transport: FetchTransportPort = {
    exchange: async ({ signal }) => {
      await new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    },
  };
  const { resolve } = resolving(["93.184.216.34"]);
  const pending = publicFetch(
    { networkMode: "open_web", resolve, transport },
    { url: "https://slow-connect.example.com/" },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});

it("refuses a non-default port, and dials the validated address on 443", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34"]);
  // `open_web` has no allowlist to consult, so it reaches the web page the
  // operator meant and nothing else on that host.
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope"), calls) },
      { url: "https://news.example.com:8443/release" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/port 443 only/);
  expect(calls).toHaveLength(0);
  await publicFetch(
    { networkMode: "open_web", resolve, transport: fakeTransport(() => html("<p>ok</p>"), calls) },
    { url: "https://news.example.com/release" },
    new AbortController().signal,
  );
  expect(calls[0]?.url.port).toBe("");
  expect(calls[0]?.address).toBe("93.184.216.34");
});

it("authorizes a loopback host:port entry against its own port, and a bare entry against every port", () => {
  // The refusal message tells the operator to add `host:port`, so that entry has
  // to be the one that works: were the loopback branch to discard every
  // port-qualified entry before comparing, `127.0.0.1:8123` could never
  // authorize `http://127.0.0.1:8123/`.
  expect(hostAllowedWithPort(new URL("http://127.0.0.1:8123/"), ["127.0.0.1:8123"])).toBe(true);
  // A bare loopback entry still means every port of that machine: an operator
  // cannot know a dev server's ephemeral port when writing the allowlist.
  expect(hostAllowedWithPort(new URL("http://127.0.0.1:8123/"), ["127.0.0.1"])).toBe(true);
  expect(hostAllowedWithPort(new URL("http://127.0.0.1:9000/"), ["127.0.0.1"])).toBe(true);
  // A port-qualified entry is not a wildcard — another port is another service —
  // and it never authorizes a URL with no port, which is the same rule from the
  // other side: `127.0.0.1:8123` must not cover `http://127.0.0.1/`.
  expect(hostAllowedWithPort(new URL("http://127.0.0.1:8124/"), ["127.0.0.1:8123"])).toBe(false);
  expect(hostAllowedWithPort(new URL("http://127.0.0.1/"), ["127.0.0.1:8123"])).toBe(false);
  // The non-loopback rule is unchanged: `example.com:8443` is a different service
  // from `example.com`, in both directions.
  expect(hostAllowedWithPort(new URL("https://example.com:8443/"), ["example.com:8443"])).toBe(true);
  expect(hostAllowedWithPort(new URL("https://example.com:8443/"), ["example.com"])).toBe(false);
  expect(hostAllowedWithPort(new URL("https://example.com/"), ["example.com:8443"])).toBe(false);
});

it("refuses a redirect with no target, and a charset it cannot decode", async () => {
  const { resolve } = resolving(["93.184.216.34"]);
  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(() => ({ status: 304, headers: { "content-type": "text/html" }, body: "" })),
      },
      { url: "https://news.example.com/not-modified" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/no redirect target/);
  await expect(
    publicFetch(
      {
        networkMode: "open_web",
        resolve,
        transport: fakeTransport(() => ({ status: 200, headers: { "content-type": "text/html; charset=Shift_JIS" }, body: "x" })),
      },
      { url: "https://news.example.com/jp" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/cannot decode charset shift_jis/);
});

it("refuses a host whose answer mixes a public IPv4 and a non-public IPv6", async () => {
  const calls: FetchExchangeRequest[] = [];
  const { resolve } = resolving(["93.184.216.34", "fd00::1"]);
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: fakeTransport(() => html("nope"), calls) },
      { url: "https://dual.example.com/" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/private/);
  expect(calls).toHaveLength(0);
});
