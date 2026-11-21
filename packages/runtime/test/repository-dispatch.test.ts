import { describe, expect, it } from "vitest";

import { dispatchRepository } from "../src/persistence/repository-handlers.js";
import { REPOSITORY_METHODS } from "../src/persistence/repository-protocol.js";
import { rpcClient } from "../src/persistence/rpc.js";
import { dispatchService } from "../src/persistence/service-handlers.js";
import { SERVICE_METHODS } from "../src/persistence/service-protocol.js";

/**
 * The store worker's repository and service operations: every one a method
 * table names reaches the method of the same group and name, with the
 * arguments it was sent. An operation the dispatch misses answers "Unknown
 * repository operation" at run time (the channel purge's `recordProgress`
 * once did).
 */

/** The repository operations the worker adapts before the call (a clock, a prompt, an optional method). */
const ADAPTED = new Set([
  "tasks.admit",
  "tasks.openHome",
  "executions.acquire",
  "executions.heartbeat",
  "executions.release",
  "executions.terminate",
  "effects.begin",
  "effects.resolve",
  "approvals.request",
  "approvals.decide",
  "approvals.cancelPendingForTask",
  "cancellations.request",
  "receipts.record",
  "artifacts.claimAttachmentForRun",
  "artifacts.putStagedArtifact",
  "messagingInbox.record",
  "messagingOutbox.begin",
  "messagingOutbox.resolve",
]);

interface Received {
  readonly operation: string;
  readonly args: unknown[];
}

/** A target whose every method records its group, name and arguments. */
function recordingTarget(calls: Received[]): never {
  return new Proxy(
    {},
    {
      get: (_groups, group) =>
        new Proxy(
          {},
          {
            get:
              (_methods, method) =>
              (...args: unknown[]) => {
                calls.push({ operation: `${String(group)}.${String(method)}`, args });
                return args;
              },
          },
        ),
    },
  ) as never;
}

const operationsOf = (table: Readonly<Record<string, readonly string[]>>): string[] =>
  Object.entries(table).flatMap(([group, methods]) => methods.map((method) => `${group}.${method}`));

describe("the repository dispatch", () => {
  it("serves every operation the table names with the repository method of that name, passing its arguments through", () => {
    const calls: Received[] = [];
    const repositories = recordingTarget(calls);
    const operations = operationsOf(REPOSITORY_METHODS);
    expect(operations.length).toBeGreaterThan(100);
    const now = { fixed: "2026-09-28T00:00:00.000Z" };
    const sent = new Map(operations.map((operation, index) => [operation, [{ now, prompt: {}, index }, now]]));
    for (const operation of operations) dispatchRepository(repositories, `repository.${operation}`, sent.get(operation));
    expect(calls.map((call) => call.operation)).toEqual(operations);
    for (const call of calls) if (!ADAPTED.has(call.operation)) expect(call.args, call.operation).toEqual(sent.get(call.operation));
  });

  it("refuses an operation the table does not name, and arguments that are not a tuple", () => {
    const repositories = recordingTarget([]);
    for (const operation of [
      "repository.tasks.missing",
      "repository.tasks.constructor",
      "repository.__proto__.get",
      "store.getTask",
      "repository.tasks",
    ]) {
      expect(() => dispatchRepository(repositories, operation, [])).toThrow("Unknown repository operation");
    }
    expect(() => dispatchRepository(repositories, "repository.tasks.get", { taskId: "task" })).toThrow(
      "Repository arguments must be a tuple",
    );
    // An unknown operation is named as one, whatever arguments it came with.
    expect(() => dispatchRepository(repositories, "repository.tasks.missing", { taskId: "task" })).toThrow("Unknown repository operation");
  });
});

describe("the service dispatch", () => {
  it("serves every operation the table names with the service method of that name, passing its arguments through", () => {
    const calls: Received[] = [];
    const services = recordingTarget(calls);
    const operations = operationsOf(SERVICE_METHODS);
    expect(operations.length).toBeGreaterThan(50);
    const sent = new Map(operations.map((operation, index) => [operation, [{ index }, "second"]]));
    for (const operation of operations) dispatchService(services, `service.${operation}`, sent.get(operation));
    expect(calls).toEqual(operations.map((operation) => ({ operation, args: sent.get(operation) })));
    expect(() => dispatchService(services, "service.memory.missing", [])).toThrow("Unknown persistence service operation");
    expect(() => dispatchService(services, "service.memory.get", {})).toThrow("Service arguments must be a tuple");
  });
});

describe("the clients", () => {
  for (const [prefix, table] of [
    ["service", SERVICE_METHODS],
    ["repository", REPOSITORY_METHODS],
  ] as const) {
    it(`send every ${prefix} method as \`${prefix}.<group>.<method>\` with its arguments unchanged`, async () => {
      const sent: Received[] = [];
      const client = rpcClient<Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>>(
        prefix,
        table,
        async (operation, args) => {
          sent.push({ operation, args });
          return operation;
        },
      );
      const expected: Received[] = [];
      for (const [group, methods] of Object.entries(table)) {
        expect(Object.keys(client[group] ?? {}), group).toEqual([...methods]);
        for (const [index, method] of methods.entries()) {
          const args = [{ group, index }, `${method}-argument`];
          expected.push({ operation: `${prefix}.${group}.${method}`, args });
          expect(await client[group]?.[method]?.(...args)).toBe(`${prefix}.${group}.${method}`);
        }
      }
      expect(sent).toEqual(expected);
    });
  }
});
