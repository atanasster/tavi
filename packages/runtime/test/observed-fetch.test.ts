import { expect, it, vi } from "vitest";
import { TLSSocket } from "node:tls";
import { Socket } from "node:net";
import type { FetchObservationHooks, ObservedFetchLimits } from "@tavi/contracts/plugin-sdk";
import type { ProviderOperationEnvelope, WebFetchResult } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import { boundPublicFetch, observeFetch, resolveFetchBinding, scopedProvider, type DispatchedFetchOptions } from "../src/index.js";

const context = { workspaceId: "w", principalId: "p", runId: "run", caller: "test" };
const url = "https://example.com/";
// Unit socket fixture only. No live-network evidence is claimed by these tests.
function socket(address = "93.184.216.34", authorized = true) {
  const result = new TLSSocket(new Socket());
  Object.defineProperty(result, "remoteAddress", { value: address });
  result.authorized = authorized;
  return result;
}
function connected(hooks: FetchObservationHooks, raw = url, address = "93.184.216.34") {
  hooks.authorize(raw, [{ address, family: 4 }]);
  hooks.connected(raw, socket(address));
}
async function consume(hooks: FetchObservationHooks, response: Response, raw = url): Promise<WebFetchResult> {
  const observed = hooks.response(raw, response);
  const chunks: Uint8Array[] = [];
  const reader = observed.body?.getReader();
  if (reader)
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value!);
    }
  return { url: raw, statusCode: response.status, truncated: false, body: { kind: "text", content: Buffer.concat(chunks).toString() } };
}
function fixture(
  run: (hooks: FetchObservationHooks, limits: ObservedFetchLimits, signal: AbortSignal) => Promise<WebFetchResult>,
  overrides: Partial<DispatchedFetchOptions> = {},
) {
  const execution = {
    ownerSession: "session",
    implementationHash: "a".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === "p",
    ledger: { reserveOperation: vi.fn(async () => {}), finishOperation: vi.fn(async () => {}), operations: async () => [] },
  };
  const provider = observeFetch("fixture", (limits, hooks) => ({
    id: "fixture",
    available: () => true,
    fetch: async (_request, signal) => run(hooks, limits, signal!),
  }));
  const options: DispatchedFetchOptions = {
    execution,
    networkMode: "open_web",
    ...overrides,
    provider: async () => [
      {
        id: "fixture",
        resolved: scopedProvider(
          execution,
          context,
          { kind: "fetch", instanceId: "fixture", accountId: "anonymous", endpoint: "in-process", configRevision: "b".repeat(64) },
          provider,
        ),
      },
    ],
  };
  return {
    provider,
    execution,
    async fetch(signal = AbortSignal.timeout(2000), envelope?: ProviderOperationEnvelope) {
      const binding = await resolveFetchBinding(options, { url }, context);
      return boundPublicFetch(options, { url }, context, signal, binding.bindingHash, undefined, envelope);
    },
  };
}

it("records actual selected socket, response bytes and same-origin redirects", async () => {
  const f = fixture(async (hooks) => {
    hooks.authorize(url, [
      { address: "93.184.216.34", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);
    hooks.connected(url, socket("8.8.8.8"));
    const redirect = hooks.response(url, new Response(null, { status: 302, headers: { location: "/next" } }));
    await redirect.body?.cancel();
    connected(hooks, "https://example.com/next");
    return consume(hooks, new Response("page", { headers: { "content-type": "text/plain" } }), "https://example.com/next");
  });
  const envelope = { taskId: "task-1", ruleId: "rule-1", tainted: true, accountingRef: "call-1" };
  expect(await f.fetch(undefined, envelope)).toMatchObject({
    provider: "fixture",
    content: { body: { content: "page" } },
    receipt: {
      bytes: 4,
      address: "93.184.216.34",
      redirects: [{ address: "8.8.8.8", from: url, to: "https://example.com/next", status: 302 }],
    },
  });
  expect(f.execution.ledger.reserveOperation).toHaveBeenCalledOnce();
  expect(f.execution.ledger.reserveOperation).toHaveBeenCalledWith(
    expect.objectContaining({ ...envelope, runId: "run", purpose: "fetch" }),
    "session",
  );
  await expect(f.provider.fetch({ url })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});
it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::ffff:127.0.0.1"])("rejects mixed DNS containing %s", async (address) => {
  await expect(
    fixture(async (hooks) => {
      hooks.authorize(url, [
        { address: "8.8.8.8", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      throw new Error("unreachable");
    }).fetch(),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});
it.each(["unverified", "rebinding", "plain object"])("rejects a %s connection", async (mode) => {
  await expect(
    fixture(async (hooks) => {
      hooks.authorize(url, [{ address: "8.8.8.8", family: 4 }]);
      hooks.connected(
        url,
        mode === "plain object"
          ? { remoteAddress: "8.8.8.8", authorized: true }
          : socket(mode === "rebinding" ? "127.0.0.1" : "8.8.8.8", mode !== "unverified"),
      );
      throw new Error("unreachable");
    }).fetch(),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});
it.each(["gzip", "deflate", "br", "gzip, br"])("cancels a %s response without reading it", async (encoding) => {
  const cancel = vi.fn();
  await expect(
    fixture(async (hooks) => {
      connected(hooks);
      return consume(
        hooks,
        new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
          headers: { "content-type": "text/plain", "content-encoding": encoding },
        }),
      );
    }).fetch(),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(["declared", "streamed"])("refuses %s byte overflow", async (mode) => {
  await expect(
    fixture(
      async (hooks) => {
        connected(hooks);
        return consume(
          hooks,
          new Response("12345", { headers: { "content-type": "text/plain", ...(mode === "declared" ? { "content-length": "5" } : {}) } }),
        );
      },
      { maxBytes: 4 },
    ).fetch(),
  ).rejects.toThrow();
});
it.each(["cross-origin", "downgrade", "port"])("refuses %s redirects", async (mode) => {
  await expect(
    fixture(async (hooks) => {
      connected(hooks);
      hooks.response(
        url,
        new Response(null, {
          status: 302,
          headers: {
            location:
              mode === "cross-origin"
                ? "https://other.example/"
                : mode === "downgrade"
                  ? "http://example.com/"
                  : "https://example.com:8443/",
          },
        }),
      );
      throw new Error("unreachable");
    }).fetch(),
  ).rejects.toThrow();
});
it("cancels a stalled body on the common deadline", async () => {
  const cancel = vi.fn();
  await expect(
    fixture(
      async (hooks) => {
        connected(hooks);
        return consume(
          hooks,
          new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { "content-type": "text/plain" } }),
        );
      },
      { timeoutMs: 20 },
    ).fetch(),
  ).rejects.toThrow();
  await expect.poll(() => cancel.mock.calls.length).toBe(1);
});
it("keeps simultaneous policy and observation state separate", async () => {
  const first = fixture(async (hooks) => {
    connected(hooks);
    await sleep(10);
    return consume(hooks, new Response("first", { headers: { "content-type": "text/plain" } }));
  });
  const second = fixture(async (hooks) => {
    connected(hooks);
    return consume(hooks, new Response("second", { headers: { "content-type": "text/plain" } }));
  });
  expect((await Promise.all([first.fetch(), second.fetch()])).map((result) => result.receipt.bytes)).toEqual([5, 6]);
});

it.each(["wrapped hook", "upstream refusal", "cross-origin"])("does not reserve or call fallback after %s", async (mode) => {
  const attempts: string[] = [];
  const fallback = vi.fn(async () => ({ url, statusCode: 200, truncated: false, body: { kind: "text" as const, content: "fallback" } }));
  const execution = {
    ownerSession: "session",
    implementationHash: "a".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === "p",
    ledger: {
      reserveOperation: async (operation: { binding: { instanceId: string } }) => {
        attempts.push(operation.binding.instanceId);
      },
      finishOperation: async () => {},
      operations: async () => [],
    },
  };
  const denied = observeFetch("denied", (_limits, hooks) => ({
    id: "denied",
    available: () => true,
    async fetch() {
      try {
        if (mode === "upstream refusal") hooks.blocked();
        else if (mode === "cross-origin") {
          connected(hooks);
          hooks.response(url, new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
        } else {
          hooks.authorize(url, [{ address: "8.8.8.8", family: 4 }]);
          hooks.connected(url, socket("127.0.0.1"));
        }
      } catch (error) {
        throw new Error("provider wrapper", { cause: new Error("HTTP wrapper", { cause: error }) });
      }
      throw new Error("unreachable");
    },
  }));
  const next = observeFetch("fallback", () => ({ id: "fallback", available: () => true, fetch: fallback }));
  const options: DispatchedFetchOptions = {
    execution,
    networkMode: "open_web",
    selection: () => ({ providers: ["denied", "fallback"], timeoutMs: 1000 }),
    provider: async () =>
      [denied, next].map((provider) => ({
        id: provider.id,
        resolved: scopedProvider(
          execution,
          context,
          { kind: "fetch", instanceId: provider.id, accountId: provider.id, endpoint: "in-process", configRevision: "b".repeat(64) },
          provider,
        ),
      })),
  };
  const binding = await resolveFetchBinding(options, { url }, context);
  await expect(boundPublicFetch(options, { url }, context, AbortSignal.timeout(1000), binding.bindingHash)).rejects.toMatchObject({
    code: "NOT_AUTHORIZED",
  });
  expect(attempts).toEqual(["denied"]);
  expect(fallback).not.toHaveBeenCalled();
});
