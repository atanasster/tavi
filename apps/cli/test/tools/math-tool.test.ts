import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { dateMath, evaluateExpression, registerMathTool } from "../../src/features/tools/math.js";

/** `math.eval`: arithmetic and date arithmetic, read by a parser that runs no code. */
describe("math.eval", () => {
  it("computes percentages, grouped numbers, precedence, powers and functions", () => {
    expect(evaluateExpression("17% of 2,340")).toBeCloseTo(397.8);
    expect(evaluateExpression("2340 * 15%")).toBeCloseTo(351);
    expect(evaluateExpression("(3 + 9 + 4) / 2 - 1")).toBe(7);
    expect(evaluateExpression("2^3^2")).toBe(512);
    expect(evaluateExpression("-3^2")).toBe(-9);
    expect(evaluateExpression("2^-1")).toBe(0.5);
    // Inside a function's parentheses a comma separates its arguments.
    expect(evaluateExpression("max(5,100)")).toBe(100);
    expect(evaluateExpression("2,340 + 1")).toBe(2341);
    expect(evaluateExpression("round(1234.5678, 2)")).toBe(1234.57);
    expect(evaluateExpression("max(3, 9, 4) + sqrt(16) + pi * 0")).toBe(13);
    expect(evaluateExpression("1_000 × 3 ÷ 4")).toBe(750);
  });

  it("refuses anything that is not arithmetic, without running it", () => {
    expect(() => evaluateExpression("process.exit(1)")).toThrow(/knows no|did not expect|cannot read/);
    expect(() => evaluateExpression("constructor")).toThrow(/knows no/);
    expect(() => evaluateExpression("1 +")).toThrow(/ends too soon/);
    expect(() => evaluateExpression("(".repeat(40) + "1" + ")".repeat(40))).toThrow(/nests too deeply/);
    expect(() => evaluateExpression("1".repeat(600))).toThrow(/at most/);
  });

  it("adds calendar amounts on the wall clock of a time zone, and measures the time between two dates", () => {
    expect(dateMath({ from: "2027-03-03", add: { days: 90 } })).toMatchObject({ result: { date: "2027-06-01T00:00", weekday: "Tuesday" } });
    // A month after the 31st is the next month's last day.
    expect(dateMath({ from: "2027-01-31", add: { months: 1 } })).toMatchObject({ result: { date: "2027-02-28T00:00" } });
    // Across a change to summer time, a day later is the same wall-clock hour.
    expect(dateMath({ from: "2027-03-27T09:00", add: { days: 1 }, timezone: "Europe/Sofia" })).toMatchObject({
      result: { date: "2027-03-28T09:00" },
    });
    expect(dateMath({ from: "2027-01-01", until: "2027-03-01" })).toMatchObject({ days: 59 });
    // Near a change of clocks: a wall time keeps its hour, and a day across the change is still a day.
    expect(dateMath({ from: "2027-03-28T04:30", timezone: "Europe/Sofia" })).toMatchObject({ result: { date: "2027-03-28T04:30" } });
    expect(dateMath({ from: "2027-03-27T02:30", add: { days: 1 }, timezone: "Europe/Sofia" })).toMatchObject({
      result: { date: "2027-03-28T02:30" },
    });
    expect(dateMath({ from: "2027-03-14T04:30", timezone: "America/New_York" })).toMatchObject({ result: { date: "2027-03-14T04:30" } });
    expect(dateMath({ from: "2027-03-13", until: "2027-03-15", timezone: "America/New_York" })).toMatchObject({ days: 2, hours: 47 });
    expect(() => dateMath({ from: "2027-02-31" })).toThrow(/not a date/);
    expect(() => dateMath({ from: "next tuesday" })).toThrow(/cannot read the date/);
    expect(() => dateMath({ from: "2027-01-01", timezone: "Mars/Olympus" })).toThrow(/time zone/);
  });

  it("is read-only and takes exactly one of an expression and a date", async () => {
    const registry = new ToolRegistry();
    registerMathTool(registry, () => new Date("2027-01-01T00:00:00Z"));
    const tool = registry.get("math.eval");
    expect(tool?.effect).toBe("read-only");
    const call = (input: unknown) =>
      tool?.handler({
        input,
        context: { workspaceId: "w", principalId: "p", runId: "r", caller: "test" },
        signal: new AbortController().signal,
      });
    expect(await call({ expression: "17% of 2340" })).toEqual({ expression: "17% of 2340", value: 397.8 });
    await expect(call({})).rejects.toThrow(/exactly one/);
    await expect(call({ expression: "1/0" })).rejects.toThrow(/not a finite number/);
  });
});
