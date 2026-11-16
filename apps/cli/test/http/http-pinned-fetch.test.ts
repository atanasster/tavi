import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { gzipSync } from "node:zlib";

import { TaviError } from "@tavi/contracts";
import { pinnedFetch, pinnedRequestOptions } from "@tavi/runtime";
import { listenLocally } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `pinnedFetch`, the transport `http.request`, the robots.txt reader and other
 * allowlisted-name callers dial through: the name is resolved once, a
 * non-public answer is refused, and the socket goes to the address checked.
 * A real loopback server stands in for "the address the socket reached", which
 * a mocked response cannot show.
 */

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  }
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

async function stub(
  respond: (request: Seen) => { status?: number; headers?: Record<string, string>; body?: Buffer | string },
  host = "127.0.0.1",
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const record = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(record);
      const answer = respond(record);
      response.writeHead(answer.status ?? 200, answer.headers ?? {});
      response.end(answer.body);
    });
  });
  servers.push(server);
  if (host === "127.0.0.1") return { port: await listenLocally(server), seen };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  return { port: (server.address() as { port: number }).port, seen };
}

function counting(answers: readonly string[]): { resolve: (hostname: string) => Promise<readonly string[]>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (hostname) => {
      asked.push(hostname);
      return answers;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<TaviError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (error instanceof TaviError) return error;
  throw new Error(`expected a TaviError, received ${String(error)}`);
}

describe("pinnedFetch", () => {
  it("resolves once and dials the address it checked, keeping the name in the Host header", async () => {
    const server = await stub(() => ({ headers: { "content-type": "text/plain" }, body: "pinned" }));
    const { resolve, asked } = counting(["127.0.0.1"]);
    const response = await pinnedFetch({ allowLoopback: true, resolve })(`http://localhost:${server.port}/a?b=1`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pinned");
    expect(asked).toEqual(["localhost"]);
    expect(server.seen[0]).toMatchObject({ method: "GET", url: "/a?b=1" });
    expect(server.seen[0]?.headers.host).toBe(`localhost:${server.port}`);
  });

  it("sends the method, headers and body, decodes a compressed body and builds a bodiless status without one", async () => {
    const server = await stub((request) =>
      request.url === "/empty"
        ? { status: 204 }
        : {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
            body: gzipSync(JSON.stringify({ echo: request.body })),
          },
    );
    const fetch = pinnedFetch({ allowLoopback: true });
    const response = await fetch(`http://127.0.0.1:${server.port}/echo`, {
      method: "POST",
      headers: { "x-trace": "t1" },
      body: "hello",
      redirect: "manual",
    });
    expect(await response.json()).toEqual({ echo: "hello" });
    expect(server.seen[0]).toMatchObject({ method: "POST", body: "hello" });
    expect(server.seen[0]?.headers).toMatchObject({ "x-trace": "t1", "content-length": "5", "accept-encoding": "identity" });
    const empty = await fetch(`http://127.0.0.1:${server.port}/empty`, { redirect: "manual" });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it("reaches an IPv6 loopback literal, brackets and all", async () => {
    const server = await stub(() => ({ body: "six" }), "::1");
    const response = await pinnedFetch({ allowLoopback: true })(`http://[::1]:${server.port}/`, { redirect: "manual" });
    expect(await response.text()).toBe("six");
  });

  it("answers a redirect rather than following it, and refuses to be asked to follow one", async () => {
    const server = await stub(() => ({ status: 302, headers: { location: "http://10.0.0.5/inside" } }));
    const fetch = pinnedFetch({ allowLoopback: true });
    const response = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://10.0.0.5/inside");
    expect(server.seen).toHaveLength(1);
    await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow(/follows no redirect/);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.5"],
    ["link-local metadata", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
  ])("refuses a name that resolves to %s before dialing it", async (_label, address) => {
    const server = await stub(() => ({ body: "reached" }));
    const { resolve } = counting([address]);
    const refused = await refusal(
      pinnedFetch({ allowLoopback: true, resolve })(`http://api.example.com:${server.port}/`, { redirect: "manual" }),
    );
    expect(refused.code).toBe("NOT_AUTHORIZED");
    expect(server.seen).toHaveLength(0);
  });

  it("refuses an answer that mixes a public and a private address", async () => {
    const { resolve } = counting(["93.184.216.34", "10.0.0.5"]);
    expect((await refusal(pinnedFetch({ resolve })("https://mixed.example.com/", { redirect: "manual" }))).code).toBe("NOT_AUTHORIZED");
  });

  it("dials loopback only for a loopback host, and only when the caller allows it", async () => {
    const server = await stub(() => ({ body: "reached" }));
    // Without `allowLoopback`, a loopback literal is as refused as any other non-public address.
    expect((await refusal(pinnedFetch()(`http://127.0.0.1:${server.port}/`, { redirect: "manual" }))).code).toBe("NOT_AUTHORIZED");
    // A `localhost` the resolver points off the machine is not loopback.
    const { resolve } = counting(["10.0.0.5"]);
    const elsewhere = await refusal(
      pinnedFetch({ allowLoopback: true, resolve })(`http://localhost:${server.port}/`, { redirect: "manual" }),
    );
    expect(elsewhere.code).toBe("NOT_AUTHORIZED");
    expect(elsewhere.message).toContain("not loopback");
    expect(server.seen).toHaveLength(0);
  });

  it("reports a resolver failure as unavailable, not as a refusal", async () => {
    const failing = async (): Promise<readonly string[]> => {
      throw new Error("ENOTFOUND");
    };
    expect((await refusal(pinnedFetch({ resolve: failing })("https://missing.example.com/", { redirect: "manual" }))).code).toBe(
      "UNAVAILABLE",
    );
  });

  it("wires plain http to port 80 with no SNI, and https to the name's SNI", () => {
    const signal = new AbortController().signal;
    const plain = pinnedRequestOptions(new URL("http://api.example.com/x"), "93.184.216.34", {}, signal, "POST");
    expect(plain).toMatchObject({ protocol: "http:", port: 80, method: "POST", hostname: "api.example.com", agent: false });
    expect(plain).not.toHaveProperty("servername");
    const literal = pinnedRequestOptions(new URL("https://[::1]:8443/"), "::1", {}, signal);
    expect(literal).toMatchObject({ protocol: "https:", port: 8443, hostname: "::1" });
    expect(literal).not.toHaveProperty("servername");
  });
});
