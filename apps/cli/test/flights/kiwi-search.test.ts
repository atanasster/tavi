import type { InvocationContext } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { FLIGHTS_PLUGIN_ID, kiwiSearch, registerOwnerFlightsTools } from "../../src/features/flights/host.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

describe("Kiwi over Tavi's MCP client", () => {
  /** A 2025-era Streamable HTTP server answering each POST with `answer(method)`; GET and DELETE refused as a stateless server does. */
  const server = (
    answer: (method: string) => unknown,
    sent: { method: string; session: string | null; redirect?: RequestInit["redirect"] }[] = [],
    status = 200,
  ) =>
    (async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      sent.push({
        method: body.method,
        session: new Headers(init.headers).get("mcp-session-id"),
        ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
      });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kiwi", version: "1" } }
          : answer(body.method);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
        status,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" },
      });
    }) as typeof fetch;

  it("initializes without a probe, carries the server's session, and returns the tool's result with its label", async () => {
    const sent: { method: string; session: string | null; redirect?: RequestInit["redirect"] }[] = [];
    const search = kiwiSearch({
      url: "https://mcp.example",
      fetch: server(() => ({ content: [{ type: "text", text: '{"itineraries":[]}' }], isError: false }), sent),
    });
    // The content, and its label: untrusted, from `mcp`, said by the server.
    expect(await search({ flyFrom: "SOF" }, new AbortController().signal)).toEqual({
      content: { itineraries: [] },
      label: { integrity: "untrusted", sources: ["mcp"], principals: ["tool:mcp.example"], confidentiality: "public", refs: [] },
    });
    // The 2025 handshake straight away (the era is known), then the call on the server's session.
    expect(sent.map(({ method, session }) => ({ method, session }))).toEqual([
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "s-1" },
      { method: "tools/call", session: "s-1" },
    ]);
    expect(sent.every((request) => request.redirect === "error")).toBe(true);
  });

  it("starts a new session when the server no longer knows the old one", async () => {
    const methods: string[] = [];
    let session = 1;
    let forgotten = false;
    const forgetful = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      const sent = new Headers(init.headers).get("mcp-session-id");
      // After a restart the server answers any request on the old session with 404.
      if (forgotten && sent === "s-1") return new Response(null, { status: 404 });
      methods.push(body.method);
      if (body.method === "initialize") session += 1;
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kiwi", version: "1" } }
          : { content: [{ type: "text", text: '{"itineraries":[]}' }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json", "mcp-session-id": `s-${String(session - 1)}` },
      });
    }) as typeof fetch;
    const search = kiwiSearch({ url: "https://mcp.example", fetch: forgetful });
    expect((await search({}, new AbortController().signal)).content).toEqual({ itineraries: [] });
    forgotten = true;
    expect((await search({}, new AbortController().signal)).content).toEqual({ itineraries: [] });
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
  });

  it("stops waiting for the handshake when the search is cancelled", async () => {
    const stalled = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    const cancelled = new AbortController();
    setTimeout(() => cancelled.abort(), 100);
    const started = Date.now();
    await expect(kiwiSearch({ url: "https://mcp.example", fetch: stalled })({}, cancelled.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("speaks only https, and stops reading an answer past 4 MiB", async () => {
    await expect(
      kiwiSearch({ url: "http://mcp.example", fetch: (async () => new Response("{}")) as typeof fetch })({}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    let pulled = 0;
    const huge = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      // An event stream with no length that never ends: read only until one event is too large.
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await expect(kiwiSearch({ url: "https://mcp.example", fetch: huge })({}, new AbortController().signal)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(pulled).toBeLessThan(10);
  });

  it("fails as unavailable when the tool fails or the server refuses", async () => {
    await expect(
      kiwiSearch({ url: "https://mcp.example", fetch: server(() => ({ isError: true, content: [{ type: "text", text: "bad date" }] })) })(
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/search-flight failed: bad date/);
    await expect(
      kiwiSearch({ url: "https://mcp.example", fetch: server(() => ({}), [], 500) })({}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("travel.flights_search over Kiwi", () => {
  const context: InvocationContext = { workspaceId: "w1", principalId: "operator", runId: "task-1", caller: "test" };
  const trip = {
    from: "SOF",
    to: "TPA",
    departDate: "2026-11-22",
    departDateTo: "2026-11-26",
    returnDate: "2027-02-01",
    returnDateTo: "2027-02-14",
    maxDurationHours: 21,
  };

  it.skipIf(process.env["TAVI_LIVE_NETWORK"] !== "1")(
    "searches Kiwi.com for real",
    async () => {
      const registry = new ToolRegistry();
      registerOwnerFlightsTools(registry, { now: () => "t" });
      const answer = (await registry
        .get("travel.flights_search")
        ?.handler({ input: trip, context, signal: new AbortController().signal })) as {
        itineraries: { price: number; outbound: { hours: number } }[];
      };
      expect(answer.itineraries.length).toBeGreaterThan(0);
      expect(answer.itineraries.every((itinerary) => itinerary.outbound.hours <= 21)).toBe(true);
    },
    60_000,
  );
});

describe("tavi.flights as a built-in", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("composes travel.flights_search while it is enabled, and leaves it out once disabled", async () => {
    const dataDir = directories.create("tavi-flights-");
    const first = await composeTaviRuntime(fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false }), {
      requireModelTransport: false,
    });
    try {
      expect(first.tools.get("travel.flights_search")).toBeDefined();
      await first.plugins.registry.disable(FLIGHTS_PLUGIN_ID, "operator");
    } finally {
      await first.close();
    }
    const second = await composeTaviRuntime(fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false }), {
      requireModelTransport: false,
    });
    try {
      expect(second.tools.get("travel.flights_search")).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});
