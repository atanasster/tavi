import type { InvocationContext, TaskFinding, TaskFindingRepositoryPort } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";
import { partialFake } from "@tavi/test-support";

import {
  amountOf,
  checkFindings,
  digestFindings,
  constraintFailure,
  fieldOf,
  registerFindingsTools,
} from "../../src/features/tools/findings.js";

const context: InvocationContext = { workspaceId: "w1", principalId: "operator", runId: "task-1", caller: "test" };

const finding = (seq: number, record: unknown): TaskFinding => ({
  taskId: "task-1",
  seq,
  kind: "flight",
  record,
  createdAt: "2026-10-08T12:00:00.000Z",
});

describe("findings.check", () => {
  const flights = [
    finding(1, { airline: "Lufthansa", price: "€898", outbound: { durationHours: 17.2, departDate: "2026-11-23" } }),
    finding(2, {
      airline: "Ryanair+Air Canada",
      price: 803,
      outbound: { durationHours: 20.8, departDate: "2026-11-23" },
      selfTransfer: true,
    }),
    finding(3, { airline: "Turkish", price: 760, outbound: { durationHours: 26, departDate: "2026-11-24" } }),
    finding(4, { airline: "Unknown", outbound: { durationHours: 15, departDate: "2026-12-01" } }),
  ];

  it("holds records to the request's constraints and names the best that pass", () => {
    const result = checkFindings(
      flights,
      [
        { field: "outbound.durationHours", op: "<", value: 21, label: "each direction under 21 hours" },
        { field: "outbound.departDate", op: "between", value: ["2026-11-21", "2026-11-27"] },
        { field: "price", op: "exists" },
      ],
      { field: "price", order: "lowest" },
    );
    expect(result.passing.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(result.best?.seq).toBe(2);
    expect(result.failing).toEqual([
      { taskId: "task-1", seq: 3, failures: ["each direction under 21 hours: 26"] },
      {
        taskId: "task-1",
        seq: 4,
        failures: ['outbound.departDate between ["2026-11-21","2026-11-27"]: "2026-12-01"', "price exists: price is missing"],
      },
    ]);
    expect(checkFindings(flights, [], { field: "outbound.durationHours", order: "highest" }).best?.seq).toBe(3);
  });

  it("compares numbers written with currency, and says what cannot be compared", () => {
    expect(constraintFailure({ price: "€898" }, { field: "price", op: "<=", value: 900 })).toBeUndefined();
    expect(constraintFailure({ price: "1,203 EUR" }, { field: "price", op: "<=", value: 900 })).toBe('price <= 900: "1,203 EUR"');
    expect(constraintFailure({ price: "call us" }, { field: "price", op: "<=", value: 900 })).toContain("cannot be compared");
    expect(constraintFailure({ selfTransfer: true }, { field: "selfTransfer", op: "!=", value: true })).toContain("cannot be compared");
    expect(constraintFailure({ cabin: "economy" }, { field: "cabin", op: "in", value: ["economy", "premium"] })).toBeUndefined();
    expect(constraintFailure({ airline: "Lufthansa Group" }, { field: "airline", op: "contains", value: "lufthansa" })).toBeUndefined();
    expect(fieldOf({ a: { b: 1 } }, "a.b")).toBe(1);
    expect([
      amountOf("898,50 лв."),
      amountOf("12,5 €"),
      amountOf("1.203,50 €"),
      amountOf("1,203.50 USD"),
      amountOf("1 203 €"),
      amountOf("$1,203"),
      amountOf("2026-11-23"),
      amountOf("call us"),
    ]).toEqual([898.5, 12.5, 1203.5, 1203.5, 1203, 1203, undefined, undefined]);
  });

  it("registers tools that keep, list and check the task's own records", async () => {
    const rows: TaskFinding[] = [];
    const repository = {
      add: async (input: { taskId: string; kind: string; records: readonly unknown[]; createdAt: string }) => {
        const added = input.records.map((record, index) => ({
          taskId: input.taskId,
          seq: rows.length + index + 1,
          kind: input.kind,
          record,
          createdAt: input.createdAt,
        }));
        rows.push(...added);
        return added;
      },
      list: async (input: { taskId: string; kind?: string; afterSeq?: number; limit: number }) =>
        rows
          .filter(
            (row) =>
              row.taskId === input.taskId && (input.kind === undefined || row.kind === input.kind) && row.seq > (input.afterSeq ?? 0),
          )
          .slice(0, input.limit),
    } as unknown as TaskFindingRepositoryPort;
    const registry = new ToolRegistry();
    registerFindingsTools(registry, {
      findings: repository,
      now: () => "2026-10-08T12:00:00.000Z",
      taskTree: async () => ["task-1", "worker-1"],
    });
    const call = (id: string, input: unknown) => registry.get(id)?.handler({ input, context, signal: new AbortController().signal });
    expect(await call("findings.check", { kind: "flight", constraints: [] })).toMatchObject({ checked: 0, passing: [] });
    expect(await call("findings.add", { kind: "flight", records: [{ price: 898 }, { price: 1200 }] })).toEqual({
      added: 2,
      from: 1,
      to: 2,
    });
    expect(await call("findings.list", { kind: "flight", limit: 1 })).toEqual({
      findings: [{ seq: 1, kind: "flight", record: { price: 898 } }],
      nextAfterSeq: 1,
    });
    expect(await call("findings.check", { kind: "flight", constraints: [{ field: "price", op: "<", value: 500 }] })).toMatchObject({
      checked: 2,
      passing: [],
      note: expect.stringContaining("not a range"),
    });
    await expect(call("findings.add", { kind: "flight", records: [{ blob: "x".repeat(9_000) }] })).rejects.toThrow(/over 8000 characters/);
    // A worker's records are the planner's to check too, and say whose they are.
    rows.push({ taskId: "worker-1", seq: 1, kind: "flight", record: { price: 450 }, createdAt: "t" });
    expect(await call("findings.check", { kind: "flight", constraints: [{ field: "price", op: "<", value: 500 }] })).toMatchObject({
      checked: 3,
      passing: [{ seq: 1, record: { price: 450 }, worker: "worker-1" }],
    });
    // A page that ends in a worker's records goes on there.
    rows.push({ taskId: "worker-1", seq: 2, kind: "flight", record: { price: 470 }, createdAt: "t" });
    const page = (await call("findings.list", { kind: "flight", limit: 3 })) as { nextAfterSeq: number; nextAfterWorker: string };
    expect(page).toMatchObject({ nextAfterSeq: 1, nextAfterWorker: "worker-1" });
    expect(await call("findings.list", { kind: "flight", afterSeq: page.nextAfterSeq, afterWorker: page.nextAfterWorker })).toEqual({
      findings: [{ seq: 2, kind: "flight", record: { price: 470 }, worker: "worker-1" }],
    });
  });

  it("shows the best passing record first and the answer before the lists, and counts what it leaves out", async () => {
    const rows: TaskFinding[] = Array.from({ length: 40 }, (_, index) => finding(index + 1, { price: 1000 - index }));
    const repository = partialFake<TaskFindingRepositoryPort>({ list: async (input: { limit: number }) => rows.slice(0, input.limit) });
    const registry = new ToolRegistry();
    registerFindingsTools(registry, { findings: repository, now: () => "t" });
    const checked = (await registry.get("findings.check")?.handler({
      input: { kind: "flight", constraints: [], best: { field: "price", order: "lowest" } },
      context,
      signal: new AbortController().signal,
    })) as Record<string, unknown> & { passing: { seq: number }[] };
    expect(Object.keys(checked).slice(0, 4)).toEqual(["checked", "passed", "best", "morePassing"]);
    expect(checked).toMatchObject({ checked: 40, passed: 40, morePassing: 10, best: { seq: 40 } });
    expect(checked.passing).toHaveLength(30);
    expect(checked.passing[0]?.seq).toBe(40);
  });

  it("digests findings for a final step, within its bound", () => {
    expect(digestFindings([])).toBeUndefined();
    expect(digestFindings([{ ...finding(1, { price: 898 }), sourceUrl: "https://flights.example/r" }])).toBe(
      '- [flight] {"price":898} (from https://flights.example/r)',
    );
    const many = Array.from({ length: 40 }, (_, index) => finding(index + 1, { note: "x".repeat(400) }));
    const digest = digestFindings(many) ?? "";
    expect(digest.length).toBeLessThan(8_600);
    expect(digest).toMatch(/- …and \d+ more$/);
    // A record near its bound is cut, not crowding out the rest.
    const big = digestFindings([finding(1, { note: "y".repeat(7_900) }), finding(2, { price: 1 })]) ?? "";
    expect(big.split("\n")).toHaveLength(2);
    expect(big).toContain('{"price":1}');
    expect(digestFindings([finding(1, { price: 1 })], true)).toBe(
      '- [flight] {"price":1}\n- …and more the task kept (findings.list reads them)',
    );
  });
});
