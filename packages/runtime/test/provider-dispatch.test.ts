import { describe, expect, it, vi } from "vitest";
import { TaviError, type ProviderOperation, type ProviderSelection } from "@tavi/contracts";
import { providerDispatcher, scopedProvider } from "../src/index.js";

const context = { workspaceId: "w", principalId: "p", runId: "run", caller: "routine" };
function fixture() {
  const owner = new AbortController();
  const operations: ProviderOperation[] = [];
  const states: string[] = [];
  const execution = {
    ownerSession: "session",
    implementationHash: "a".repeat(64),
    signal: owner.signal,
    actsIn: (workspaceId: string, principalId: string) => principalId === (workspaceId === "w" ? "p" : undefined),
    ledger: {
      reserveOperation: async (operation: ProviderOperation) => {
        operations.push(operation);
      },
      finishOperation: async (_run: string, _attempt: string, state: string) => {
        states.push(state);
      },
      operations: async () => [],
    },
  };
  const calls = [vi.fn(async () => "a"), vi.fn(async () => "b")];
  let selection: ProviderSelection | undefined;
  const candidates = calls.map((call, index) => ({
    id: String(index),
    resolved: scopedProvider(
      execution,
      context,
      {
        kind: "search",
        instanceId: `provider-${index}`,
        accountId: `account-${index}`,
        endpoint: `https://p${index}.example`,
        configRevision: "b".repeat(64),
      },
      call,
    ),
  }));
  const dispatcher = providerDispatcher({ execution, candidates: async () => candidates, selection: () => selection });
  const dispatch = async (reserve?: () => Promise<void>) => {
    const binding = await dispatcher.resolve(context);
    return dispatcher.dispatch({
      context,
      signal: new AbortController().signal,
      expectedBindingHash: binding.bindingHash,
      ...(reserve === undefined ? {} : { reserve }),
      invoke: (provider) => provider(),
    });
  };
  return {
    owner,
    calls,
    operations,
    states,
    dispatcher,
    dispatch,
    select: (value: ProviderSelection) => {
      selection = value;
    },
  };
}

describe("shared provider dispatcher", () => {
  it("requires explicit selection for ambiguity and never reserves an unknown provider", async () => {
    const f = fixture();
    await expect(f.dispatch()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    f.select({ providers: ["missing"], timeoutMs: 1000 });
    await expect(f.dispatch()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.operations).toHaveLength(0);
    expect(f.calls.every((call) => call.mock.calls.length === 0)).toBe(true);
  });
  it("reserves each explicitly allowed fallback separately", async () => {
    const f = fixture();
    f.select({ providers: ["0", "1"], timeoutMs: 1000 });
    f.calls[0]!.mockRejectedValue(new TaviError("UNAVAILABLE", "down"));
    expect(await f.dispatch()).toEqual({ provider: "1", result: "b" });
    expect(f.operations.map((operation) => operation.binding.accountId)).toEqual(["account-0", "account-1"]);
    expect(new Set(f.operations.map((operation) => operation.attemptId)).size).toBe(2);
    expect(f.states).toEqual(["uncertain", "completed"]);
  });
  it.each(["NOT_CONFIGURED", "NOT_AUTHORIZED"] as const)("stops the chain at %s without reserving the next provider", async (code) => {
    const f = fixture();
    f.select({ providers: ["0", "1"], timeoutMs: 1000 });
    f.calls[0]!.mockRejectedValue(new TaviError(code, "refused"));
    let reservations = 0;
    await expect(
      f.dispatch(async () => {
        reservations++;
      }),
    ).rejects.toMatchObject({ code });
    expect(reservations).toBe(1);
    expect(f.operations.map((operation) => operation.binding.accountId)).toEqual(["account-0"]);
    expect(f.calls[1]).not.toHaveBeenCalled();
    expect(f.states).toEqual(["uncertain"]);
  });
  it("records the caller's envelope on each attempt's operation", async () => {
    const f = fixture();
    f.select({ providers: ["0"], timeoutMs: 1000 });
    const binding = await f.dispatcher.resolve(context);
    const envelope = { taskId: "task", ruleId: "rule", tainted: false, accountingRef: "call" };
    await f.dispatcher.dispatch({
      context,
      signal: new AbortController().signal,
      expectedBindingHash: binding.bindingHash,
      envelope,
      invoke: (provider) => provider(),
    });
    expect(f.operations).toEqual([expect.objectContaining(envelope)]);
  });
  it("does not fall back beyond an explicit single selection", async () => {
    const f = fixture();
    f.select({ providers: ["0"], timeoutMs: 1000 });
    f.calls[0]!.mockRejectedValue(new TaviError("UNAVAILABLE", "down"));
    await expect(f.dispatch()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.calls[1]).not.toHaveBeenCalled();
  });
  it("names each failed provider's own reason, and only the id for an untyped error", async () => {
    const f = fixture();
    f.select({ providers: ["0", "1"], timeoutMs: 1000 });
    f.calls[0]!.mockRejectedValue(new TaviError("UNAVAILABLE", "answered 400: Query cannot consist only of site: operators"));
    f.calls[1]!.mockRejectedValue(new Error("socket /secret/path"));
    await expect(f.dispatch()).rejects.toThrow(
      "No selected provider answered (0: answered 400: Query cannot consist only of site: operators; 1)",
    );
  });
  it("shares one deadline and settles an adapter that ignores cancellation", async () => {
    const f = fixture();
    f.select({ providers: ["0", "1"], timeoutMs: 20 });
    f.calls[0]!.mockImplementation(() => new Promise(() => {}));
    await expect(f.dispatch()).rejects.toThrow(/exceeded 20ms/);
    expect(f.calls[1]).not.toHaveBeenCalled();
    await expect.poll(() => f.states).toEqual(["uncertain"]);
  });
  it("aborts a noncooperative call on withdrawal without using another account", async () => {
    const f = fixture();
    f.select({ providers: ["0", "1"], timeoutMs: 1000 });
    f.calls[0]!.mockImplementation(async () => {
      f.owner.abort(new Error("withdrawn"));
      return new Promise(() => {});
    });
    await expect(f.dispatch()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(f.calls[1]).not.toHaveBeenCalled();
    expect(f.states).toEqual(["uncertain"]);
  });
  it("rechecks chain selection after reservation before any wire request", async () => {
    const f = fixture();
    f.select({ providers: ["0"], timeoutMs: 1000 });
    await expect(
      f.dispatch(async () => {
        f.select({ providers: ["1"], timeoutMs: 1000 });
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(f.calls.every((call) => call.mock.calls.length === 0)).toBe(true);
  });
});

it("refuses a fetch provider without host transport support before invocation", async () => {
  const { boundPublicFetch, resolveFetchBinding } = await import("../src/fetch-tool.js");
  const fetch = vi.fn(async () => ({
    url: "https://example.com/",
    statusCode: 200,
    body: { kind: "text" as const, content: "forged" },
    truncated: false,
  }));
  const execution = {
    ownerSession: "session",
    implementationHash: "a".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === "p",
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  const provider = { id: "external", available: () => true, fetch };
  const options = {
    execution,
    networkMode: "open_web" as const,
    provider: async () => [
      {
        id: "external",
        resolved: scopedProvider(
          execution,
          context,
          { kind: "fetch", instanceId: "external", accountId: "external", endpoint: "https://example.com", configRevision: "b".repeat(64) },
          provider,
        ),
      },
    ],
  };
  const input = { url: "https://example.com/" };
  const binding = await resolveFetchBinding(options, input, context);
  await expect(boundPublicFetch(options, input, context, new AbortController().signal, binding.bindingHash)).rejects.toThrow(
    /no supported host-observed transport/,
  );
  expect(fetch).not.toHaveBeenCalled();
});
