import { assessHttpRequest } from "../../src/features/approvals/call-assessors.js";
import { createServer, type Server } from "node:http";

import { TOOL_LABEL_KEY, TaviError, type InvocationContext, type SecretReaderPort } from "@tavi/contracts";
import { ToolRegistry, pinnedFetch } from "@tavi/runtime";
import { listenLocally } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostAllowed,
  isLoopbackHostname,
  normalizeHostEntry,
  registerHttpTools,
  rejectUrl,
  httpRequestDescription,
} from "../../src/features/http/tools.js";

/**
 * `http.request` — the keystone capability of the chief-of-staff scenario.
 * These tests pin the properties the design rests on:
 * the host allowlist is operator policy and redirects do not escape it, a
 * credential is operator-bound and never returned, the model never supplies auth
 * material, the response is bounded while it is read, and failures are typed.
 */

const context: InvocationContext = {
  workspaceId: "w1",
  principalId: "alice",
  runId: "run-1",
  caller: "model",
};

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  }
});

function secretReader(values: Readonly<Record<string, string>>): SecretReaderPort {
  return {
    async getSecret(reference: string): Promise<string | null> {
      return values[reference] ?? null;
    },
  };
}

interface Stub {
  readonly baseUrl: string;
  readonly requests: { readonly url: string; readonly method: string; readonly authorization: string | undefined; readonly body: string }[];
}

async function startStub(
  respond: (request: { url: string; method: string; authorization: string | undefined; body: string }) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    raw?: (response: import("node:http").ServerResponse) => void;
  },
): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const authorization = request.headers["authorization"];
      const record = {
        url: request.url ?? "/",
        method: request.method ?? "GET",
        authorization: typeof authorization === "string" ? authorization : undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      (requests as { url: string; method: string; authorization: string | undefined; body: string }[]).push(record);
      const result = respond(record);
      if (result.raw !== undefined) {
        result.raw(response);
        return;
      }
      response.writeHead(result.status ?? 200, { "content-type": "application/json", ...(result.headers ?? {}) });
      response.end(result.body ?? "{}");
    });
  });
  servers.push(server);
  const port = await listenLocally(server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function fixture(options: Parameters<typeof registerHttpTools>[1]): ToolRegistry {
  const registry = new ToolRegistry();
  registerHttpTools(registry, options);
  return registry;
}

function call(registry: ToolRegistry, input: unknown): Promise<unknown> {
  const tool = registry.get("http.request");
  if (tool === undefined) throw new Error("http.request is not registered");
  return tool.handler({ input, context, signal: new AbortController().signal });
}

const bound = { "acme.stripe.key": ["127.0.0.1"] };

async function rejection(promise: Promise<unknown>): Promise<TaviError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaviError) return error;
    throw new Error(`expected a TaviError, received ${String(error)}`);
  }
  throw new Error("expected the call to reject");
}

describe("operator-extended request headers", () => {
  it("allows a header the operator named, refuses a credential header, and refuses a non-token name", () => {
    const registry = new ToolRegistry();
    const allow = (extra: readonly string[]) =>
      registerHttpTools(registry, {
        secretReader: {
          async getSecret() {
            return null;
          },
        },
        allowedHosts: ["api.example.com"],
        extraAllowedRequestHeaders: extra,
      });
    // A legitimate non-credential header the operator allows.
    expect(() => allow(["idempotency-key"])).not.toThrow();
    // A credential header is never the model's to set, however the operator asks.
    expect(() => allow(["authorization"])).toThrow(/names a credential header/);
    // A name that is not an RFC 7230 token would be a header injection.
    expect(() => allow(["x-evil: value"])).toThrow(/not a valid header name/);
  });
});

describe("http.request — host allowlist", () => {
  it("denies every host when the allowlist is empty, without dispatching", async () => {
    let dispatched = false;
    const registry = fixture({
      secretReader: secretReader({}),
      allowedHosts: [],
      fetchImpl: (async () => {
        dispatched = true;
        return new Response("nope");
      }) as typeof fetch,
    });
    expect((await rejection(call(registry, { url: "https://api.stripe.com/v1/charges" }))).code).toBe("NOT_AUTHORIZED");
    expect(dispatched).toBe(false);
  });

  it("refuses a host that is not on the allowlist", async () => {
    let dispatched = false;
    const registry = fixture({
      secretReader: secretReader({}),
      allowedHosts: ["api.stripe.com"],
      fetchImpl: (async () => {
        dispatched = true;
        return new Response("nope");
      }) as typeof fetch,
    });
    expect((await rejection(call(registry, { url: "https://evil.example/steal" }))).code).toBe("NOT_AUTHORIZED");
    expect(dispatched).toBe(false);
  });

  it("permits an allowlisted loopback host over http (so a local provider stub is reachable)", async () => {
    const stub = await startStub(() => ({ body: JSON.stringify({ ok: true }) }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    const result = (await call(registry, { url: `${stub.baseUrl}/health` })) as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("requires a non-default port to be named in the allowlist", async () => {
    // `normalizeHostEntry` keeps only the hostname, so `example.com:8443` was
    // silently compared as `example.com` and an entry for the bare host authorized
    // a different service on any port.
    let dispatched = false;
    const fetchImpl = (async () => {
      dispatched = true;
      return new Response("nope");
    }) as typeof fetch;
    const bare = fixture({ secretReader: secretReader({}), allowedHosts: ["example.com"], fetchImpl });
    const refused = await rejection(call(bare, { url: "https://example.com:8443/x" }));
    expect(refused.code).toBe("NOT_AUTHORIZED");
    expect(refused.message).toContain("example.com:8443");
    expect(refused.message).toContain("non-default port");
    expect(dispatched).toBe(false);

    // Naming the port authorizes exactly that port.
    const withPort = fixture({ secretReader: secretReader({}), allowedHosts: ["example.com:8443"], fetchImpl });
    const allowed = (await call(withPort, { url: "https://example.com:8443/x" })) as { status: number };
    expect(allowed.status).toBe(200);
    // ...and not the bare host.
    expect((await rejection(call(withPort, { url: "https://example.com/x" }))).code).toBe("NOT_AUTHORIZED");
  });

  it("accepts any port on loopback, which is one trust domain", async () => {
    // An operator cannot know a dev server's ephemeral port when writing the
    // allowlist, and `http://` is already restricted to loopback.
    const stub = await startStub(() => ({ body: "ok" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    expect(((await call(registry, { url: `${stub.baseUrl}/any` })) as { status: number }).status).toBe(200);
  });

  it("requires https for a non-loopback host even when allowlisted", async () => {
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["example.com"] });
    expect((await rejection(call(registry, { url: "http://example.com/plain" }))).code).toBe("NOT_AUTHORIZED");
  });

  it("refuses credentials embedded in the URL", async () => {
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["example.com"] });
    const error = await rejection(call(registry, { url: "https://user:pw@example.com/x" }));
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(error.message).toContain("userinfo");
  });
});

describe("http.request — an allowlisted name is dialed only at a public address", () => {
  it("refuses, as NOT_AUTHORIZED, a name that resolves to loopback when it is dialed, without sending the credential", async () => {
    // The rebinding answer: the allowlist checked a public name, the resolver now
    // points it at the machine's own services.
    const stub = await startStub(() => ({ body: "internal" }));
    const port = new URL(stub.baseUrl).port;
    const registry = fixture({
      secretReader: secretReader({ "acme.key": "sk_live_rebound" }),
      allowedHosts: [`api.example.com:${port}`],
      credentialHosts: { "acme.key": [`api.example.com:${port}`] },
      fetchImpl: pinnedFetch({ allowLoopback: true, resolve: async () => ["127.0.0.1"] }),
    });
    const refused = await rejection(call(registry, { url: `https://api.example.com:${port}/v1/data`, credentialRef: "acme.key" }));
    expect(refused.code).toBe("NOT_AUTHORIZED");
    expect(refused.message).toContain("loopback");
    expect(stub.requests).toHaveLength(0);
  });

  it("still reaches an explicitly allowlisted IPv6 loopback over http", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ six: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["[::1]"] });
    const result = (await call(registry, { url: `http://[::1]:${port}/health` })) as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ six: true });
  });
});

describe("http.request — redirects never leave the allowlist", () => {
  it("returns a 3xx instead of following it, and does not contact the target", async () => {
    const elsewhere = await startStub(() => ({ body: "STOLEN" }));
    const origin = await startStub(() => ({ status: 302, headers: { location: `${elsewhere.baseUrl}/stolen` }, body: "" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });

    const result = (await call(registry, { url: `${origin.baseUrl}/go` })) as {
      status: number;
      redirected: boolean;
      location: string | null;
      body?: string;
    };
    expect(result.status).toBe(302);
    expect(result.redirected).toBe(true);
    expect(result.location).toContain("/stolen");
    expect(result.body).toBeUndefined();
    // The off-allowlist target was never contacted, so its body never reaches the model.
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("does not re-send a POST body to a redirect target", async () => {
    const elsewhere = await startStub(() => ({ body: "STOLEN" }));
    const origin = await startStub(() => ({ status: 307, headers: { location: `${elsewhere.baseUrl}/stolen` }, body: "" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });

    await call(registry, { url: `${origin.baseUrl}/go`, method: "POST", body: "proprietary" });
    expect(elsewhere.requests).toHaveLength(0);
    expect(origin.requests[0]?.body).toBe("proprietary");
  });
});

describe("http.request — credential binding and injection", () => {
  it("injects a bound credential and never returns it", async () => {
    const stub = await startStub(() => ({ body: JSON.stringify({ hello: "world" }) }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret-value" }),
      allowedHosts: ["127.0.0.1"],
      credentialHosts: bound,
    });
    const result = await call(registry, { url: `${stub.baseUrl}/v1/charges`, credentialRef: "acme.stripe.key" });

    expect(stub.requests[0]?.authorization).toBe("Bearer s3cret-value");
    expect(JSON.stringify(result)).not.toContain("s3cret-value");
    // What a stored credential opened is the person's.
    expect(result).toMatchObject({ [TOOL_LABEL_KEY]: { confidentiality: "personal" } });
  });

  it("refuses a credential that the operator has not bound to any host", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret-value" }),
      allowedHosts: ["127.0.0.1"],
    });
    expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }))).code).toBe("NOT_AUTHORIZED");
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses a credential bound to a different host", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret-value" }),
      allowedHosts: ["127.0.0.1"],
      credentialHosts: { "acme.stripe.key": ["api.stripe.com"] },
    });
    expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }))).code).toBe("NOT_AUTHORIZED");
    expect(stub.requests).toHaveLength(0);
  });

  it("does not hand the model the credential-to-host binding map", async () => {
    // The map is operator configuration, and listing it back tells the model which
    // hosts this credential is good for — a map it can then aim at. The message names the one binding it needs instead.
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret-value" }),
      allowedHosts: ["127.0.0.1"],
      credentialHosts: { "acme.stripe.key": ["api.stripe.com", "api.other.example"] },
    });
    const error = await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }));
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(error.message).not.toContain("api.other.example");
    expect(JSON.stringify(error.details ?? {})).not.toContain("api.other.example");
    // The remedy it does name is the one that would work.
    expect(error.message).toContain("--http-credential-host acme.stripe.key=127.0.0.1");
  });

  it("permits only the allowlisted request headers, because every provider names auth differently", async () => {
    // The denylist this replaced named seven spellings and missed `x-goog-api-key`,
    // `private-token` (GitLab), `x-subscription-key`, `x-functions-key` and
    // `x-amz-security-token` — the provider that invents the next one is the point.
    let dispatched = false;
    const registry = fixture({
      secretReader: secretReader({}),
      allowedHosts: ["127.0.0.1"],
      fetchImpl: (async () => {
        dispatched = true;
        return new Response("ok");
      }) as typeof fetch,
    });
    for (const name of [
      "x-goog-api-key",
      "private-token",
      "x-subscription-key",
      "x-functions-key",
      "x-amz-security-token",
      "authorization",
    ]) {
      const error = await rejection(call(registry, { url: "https://127.0.0.1/x", headers: { [name]: "model-chosen" } }));
      expect(error.code, name).toBe("NOT_AUTHORIZED");
      expect(error.message, name).toContain("may not set");
    }
    expect(dispatched).toBe(false);
  });

  it("never lets a rejected header value carry the secret into the error", async () => {
    // `Headers.set` quotes the offending value in its TypeError, and for a
    // credential header that value is the operator's secret — which the invocation
    // path forwards to the model as `error.message`.
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret\r\nX-Evil: 1" }),
      allowedHosts: ["127.0.0.1"],
      credentialHosts: { "acme.stripe.key": ["127.0.0.1"] },
    });
    const error = await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).not.toContain("s3cret");
    expect(error.message).not.toContain("X-Evil");
    expect(stub.requests).toHaveLength(0);

    // The model's own header values are refused the same way, and the refusal does
    // not echo the value either.
    const modelSupplied = await rejection(call(registry, { url: `${stub.baseUrl}/x`, headers: { accept: "a\r\nX-Evil: 1" } }));
    expect(modelSupplied.code).toBe("INVALID_INPUT");
    expect(modelSupplied.message).not.toContain("X-Evil");
  });

  it("refuses a wildcard over a shared suffix, where every subdomain is someone else's", async () => {
    // `*.s3.amazonaws.com` reads as "my bucket" and grants every bucket anyone has
    // registered: an injected instruction can post the operator's data to
    // `attacker.s3.amazonaws.com`, and a credential bound to the same pattern goes
    // with it.
    for (const suffix of ["s3.amazonaws.com", "workers.dev", "github.io"]) {
      expect(normalizeHostEntry(`*.${suffix}`), suffix).toBeUndefined();
      // A subdomain of a shared suffix is refused too — `*.eu.s3.amazonaws.com`
      // has the same problem one level down.
      expect(normalizeHostEntry(`*.eu.${suffix}`), suffix).toBeUndefined();
      // The exact host is still expressible, which is the point.
      expect(normalizeHostEntry(`my-bucket.${suffix}`), suffix).toBe(`my-bucket.${suffix}`);
    }
    // An ordinary operator-owned domain keeps working as a wildcard, including a
    // Google API host — those subdomains are Google's and cannot be registered by
    // a third party, which is the criterion.
    expect(normalizeHostEntry("*.example.com")).toBe("*.example.com");
    expect(normalizeHostEntry("*.googleapis.com")).toBe("*.googleapis.com");

    // The regional and dualstack spellings are the canonical S3 forms, so listing
    // only `s3.amazonaws.com` left the live ones open.
    for (const entry of [
      "*.s3.eu-west-1.amazonaws.com",
      "*.s3.dualstack.us-east-1.amazonaws.com",
      "*.execute-api.us-east-1.amazonaws.com",
    ]) {
      expect(normalizeHostEntry(entry), entry).toBeUndefined();
    }
    // A trailing dot is the same name to DNS and TLS, so it cannot smuggle an
    // entry past the guard.
    expect(normalizeHostEntry("*.s3.amazonaws.com.")).toBeUndefined();
    expect(normalizeHostEntry("api.stripe.com.")).toBe("api.stripe.com");
  });

  it("refuses a wide-open wildcard-with-port entry instead of degrading it to the whole suffix", async () => {
    // `*.example.com:8443` normalized to `*.example.com` and authorized the entire
    // suffix on the default port — fail-open, in the exact direction the port check
    // closes.
    expect(normalizeHostEntry("*.example.com:8443")).toBeUndefined();
    expect(normalizeHostEntry("*.example.com")).toBe("*.example.com");
    expect(normalizeHostEntry("example.com:8443")).toBe("example.com");
  });

  it("does not walk Object.prototype for a credential reference", async () => {
    // `credentialHosts["__proto__"]` resolved through the prototype chain and
    // reached the host check as a non-array, throwing an untyped TypeError.
    const registry = fixture({ secretReader: secretReader({ __proto__: "x" }), allowedHosts: ["127.0.0.1"] });
    const error = await rejection(call(registry, { url: "https://127.0.0.1/x", credentialRef: "__proto__" }));
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(error.message).toContain("not bound to any host");
  });

  it("refuses an unconfigured credential instead of dispatching with an empty one", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"], credentialHosts: bound });
    // An early prototype's bug, as a regression test: it sent `Bearer undefined`.
    expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }))).code).toBe("INVALID_INPUT");
    expect(stub.requests).toHaveLength(0);
  });

  it("treats a reader that returns undefined as not configured", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const sloppyReader = {
      async getSecret(): Promise<string | null> {
        return undefined as unknown as string | null;
      },
    };
    const registry = fixture({ secretReader: sloppyReader, allowedHosts: ["127.0.0.1"], credentialHosts: bound });
    expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }))).code).toBe("INVALID_INPUT");
    expect(stub.requests).toHaveLength(0);
  });

  it("does not leak a reader failure's message (which may carry a path) to the model", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const failing = {
      async getSecret(): Promise<string | null> {
        throw new Error("Credential reference x is bound to /home/op/.tavi/credentials/x");
      },
    };
    const registry = fixture({ secretReader: failing, allowedHosts: ["127.0.0.1"], credentialHosts: bound });
    const error = await rejection(call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key" }));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).not.toContain("/home/op");
  });
});

describe("http.request — the model never supplies auth material", () => {
  it("refuses a model-supplied authorization header with no credentialRef", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    const error = await rejection(call(registry, { url: `${stub.baseUrl}/x`, headers: { authorization: "Bearer MODEL-CHOSEN" } }));
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses other credential-shaped headers too", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    for (const name of ["x-api-key", "Cookie", "x-auth-token", "api-key"]) {
      expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, headers: { [name]: "model" } }))).code).toBe("NOT_AUTHORIZED");
    }
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses a non-token header name as a typed input error", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    expect((await rejection(call(registry, { url: `${stub.baseUrl}/x`, headers: { "bad header name": "v" } }))).code).toBe("INVALID_INPUT");
  });

  it("refuses an invalid credentialHeader before dispatch", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({
      secretReader: secretReader({ "acme.stripe.key": "s3cret" }),
      allowedHosts: ["127.0.0.1"],
      credentialHosts: bound,
    });
    const error = await rejection(
      call(registry, { url: `${stub.baseUrl}/x`, credentialRef: "acme.stripe.key", credentialHeader: "bad header name" }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("http.request — bounded, redacted, typed response", () => {
  it("truncates a body over the cap while reading, and says so", async () => {
    const stub = await startStub(() => ({ body: "x".repeat(5_000) }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"], maxResponseBytes: 100 });
    const result = (await call(registry, { url: `${stub.baseUrl}/big` })) as {
      body: string;
      truncated: boolean;
      bytes: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(100);
    expect(result.bytes).toBeGreaterThanOrEqual(100);
  });

  it("stops reading a very large response instead of buffering it", async () => {
    // The pre-repair implementation called `arrayBuffer()`, so a response this
    // size was fully materialised before the cap was applied. With a streaming
    // read the call still returns promptly and the result stays capped.
    const stub = await startStub(() => ({
      raw: (response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let i = 0; i < 320; i += 1) response.write(chunk); // 20 MiB
        response.end();
      },
    }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"], maxResponseBytes: 512 });
    const result = (await call(registry, { url: `${stub.baseUrl}/huge` })) as { body: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(512);
  });

  it("returns only non-sensitive response headers, with bounded values", async () => {
    const stub = await startStub(() => ({
      headers: {
        "set-cookie": "session=abc",
        "x-ratelimit-remaining": "9",
        "x-internal-secret": "leak",
        "content-type": `application/json; ${"p".repeat(4_000)}`,
      },
      body: "{}",
    }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    const result = (await call(registry, { url: `${stub.baseUrl}/headers` })) as {
      headers: Record<string, string>;
      contentType: string;
    };
    expect(result.headers["x-ratelimit-remaining"]).toBe("9");
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["x-internal-secret"]).toBeUndefined();
    expect(result.contentType.length).toBeLessThanOrEqual(1_024);
  });

  it("maps a timeout during the body read to a typed UNAVAILABLE", async () => {
    const stub = await startStub(() => ({
      raw: (response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("starting…"); // never ends
      },
    }));
    const registry = fixture({
      secretReader: secretReader({}),
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 300,
      maxResponseBytes: 1024,
    });
    const error = await rejection(call(registry, { url: `${stub.baseUrl}/hang` }));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("timed out");
  });
});

describe("host and loopback normalization", () => {
  it("matches exact hosts and *.suffix entries only", () => {
    expect(hostAllowed("api.stripe.com", ["api.stripe.com"])).toBe(true);
    expect(hostAllowed("API.Stripe.com", ["api.stripe.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["api.stripe.com"])).toBe(false);
    expect(hostAllowed("analyticsdata.googleapis.com", ["*.googleapis.com"])).toBe(true);
    expect(hostAllowed("googleapis.com", ["*.googleapis.com"])).toBe(false);
    expect(hostAllowed("notgoogleapis.com", ["*.googleapis.com"])).toBe(false);
    expect(hostAllowed("anything", [""])).toBe(false);
    // An entry is normalized the way the request host is, so a Unicode spelling
    // cannot silently never match.
    expect(hostAllowed("xn--exmple-cua.com", ["exämple.com"])).toBe(true);
    expect(hostAllowed("[::1]", ["[0:0:0:0:0:0:0:1]"])).toBe(true);
  });

  it("normalizes a malformed entry to undefined rather than a bogus host", () => {
    expect(normalizeHostEntry("  api.stripe.com  ")).toBe("api.stripe.com");
    expect(normalizeHostEntry("*.Example.com")).toBe("*.example.com");
    expect(normalizeHostEntry("")).toBeUndefined();
  });

  it("recognizes every loopback spelling that URL can produce", () => {
    for (const host of ["127.0.0.1", "127.1", "0x7f.0.0.1", "2130706433", "0177.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "localhost"]) {
      expect(isLoopbackHostname(new URL(`http://${host}/`).hostname)).toBe(true);
    }
    expect(isLoopbackHostname("example.com")).toBe(false);
  });

  it("reports why a URL is refused", () => {
    expect(rejectUrl(new URL("http://api.stripe.com/x"), ["api.stripe.com"])).toContain("only https");
    expect(rejectUrl(new URL("https://api.stripe.com/x"), [])).toContain("allowlist");
    expect(rejectUrl(new URL("https://api.stripe.com/x"), ["api.stripe.com"])).toBeUndefined();
  });
});

describe("http.request — what it says it can reach", () => {
  it("names its allowed hosts and its credentials by name, never a value nor where each is bound, bounded", () => {
    const description = httpRequestDescription({
      allowedHosts: ["api.stripe.com", "*.example.com"],
      credentialHosts: { "acme.stripe.key": ["api.stripe.com", "api.other.example"] },
    });
    expect(description).toContain("It can reach api.stripe.com, *.example.com.");
    expect(description).toContain("acme.stripe.key");
    expect(description).not.toContain("api.other.example");
    expect(httpRequestDescription({ allowedHosts: ["a.example"] })).toContain("No credential is bound.");
    const many = httpRequestDescription({ allowedHosts: Array.from({ length: 25 }, (_, index) => `h${index}.example`) });
    expect(many).toContain("h19.example and 5 more.");
    expect(many).not.toContain("h20.example");
  });

  it("rates a DELETE high, a credentialed one too, and a PATCH medium", () => {
    expect(assessHttpRequest({ url: "https://api.example.com/x/1", method: "DELETE" })).toMatchObject({ risk: "high" });
    expect(assessHttpRequest({ url: "https://api.example.com/x/1", method: "DELETE", credentialRef: "k" })).toMatchObject({ risk: "high" });
    expect(assessHttpRequest({ url: "https://api.example.com/x/1", method: "PATCH" })).toMatchObject({ risk: "medium" });
  });

  it("sends PUT, PATCH and DELETE as asked", async () => {
    const stub = await startStub(() => ({ body: "{}" }));
    const registry = fixture({ secretReader: secretReader({}), allowedHosts: ["127.0.0.1"] });
    for (const method of ["PUT", "PATCH", "DELETE"])
      await call(registry, { url: `${stub.baseUrl}/x`, method, ...(method === "DELETE" ? {} : { body: "{}" }) });
    expect(stub.requests.map((request) => request.method)).toEqual(["PUT", "PATCH", "DELETE"]);
  });
});
