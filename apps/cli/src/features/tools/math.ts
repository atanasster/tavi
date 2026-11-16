import { z } from "zod";

import { TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

/**
 * `math.eval`: a calculator and date arithmetic that needs no sandbox and no
 * approval. An expression is read by a small recursive-descent parser over
 * numbers, operators and a fixed set of functions — never `eval` or `new
 * Function` — so nothing in it can run code, read a file or reach the network.
 */

/** The longest expression read, and the deepest nesting: a sum a person asks for, not a program. */
const MAX_EXPRESSION_CHARS = 500;
const MAX_DEPTH = 32;

const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  round: (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  ln: Math.log,
  log: (value, base = 10) => Math.log(value) / Math.log(base),
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "symbol"; readonly value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const source = expression.replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  let at = 0;
  // Inside parentheses a comma separates a function's arguments, so it never groups a number's thousands there.
  let depth = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const space = /^\s+/.exec(rest);
    if (space !== null) {
      at += space[0].length;
      continue;
    }
    // A number may group its thousands with commas or underscores: 2,340 and 1_000 are one number each.
    const grouping =
      depth === 0 ? /^(\d{1,3}(?:[,_]\d{3})+(?!\d)|\d+)(\.\d+)?(?:e[+-]?\d+)?/i : /^(\d{1,3}(?:_\d{3})+(?!\d)|\d+)(\.\d+)?(?:e[+-]?\d+)?/i;
    const number = grouping.exec(rest) ?? /^\.\d+/.exec(rest);
    if (number !== null) {
      tokens.push({ kind: "number", value: Number(number[0].replace(/[,_]/g, "")) });
      at += number[0].length;
      continue;
    }
    const word = /^[a-z]+/i.exec(rest);
    if (word !== null) {
      tokens.push({ kind: "word", value: word[0].toLowerCase() });
      at += word[0].length;
      continue;
    }
    const symbol = /^(\*\*|[-+*/^%(),])/.exec(rest);
    if (symbol === null) throw new TaviError("INVALID_INPUT", `math.eval cannot read "${rest.slice(0, 12)}"`);
    tokens.push({ kind: "symbol", value: symbol[0] === "**" ? "^" : symbol[0] });
    if (symbol[0] === "(") depth += 1;
    if (symbol[0] === ")") depth = Math.max(0, depth - 1);
    at += symbol[0].length;
  }
  return tokens;
}

/**
 * The value of an arithmetic expression: `+ - * / ^` (and `**`), parentheses,
 * `%` as a percentage (`17% of 2340`, `2340 * 15%`), the functions in
 * `FUNCTIONS`, and `pi` and `e`. Throws `INVALID_INPUT` on anything else.
 */
export function evaluateExpression(expression: string): number {
  if (expression.length > MAX_EXPRESSION_CHARS)
    throw new TaviError("INVALID_INPUT", `math.eval reads at most ${MAX_EXPRESSION_CHARS} characters`);
  const tokens = tokenize(expression);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const isSymbol = (value: string): boolean => peek()?.kind === "symbol" && peek()?.value === value;
  const expect = (value: string): void => {
    if (!isSymbol(value)) throw new TaviError("INVALID_INPUT", `math.eval expected "${value}"`);
    at += 1;
  };

  const sum = (depth: number): number => {
    let value = product(depth);
    while (isSymbol("+") || isSymbol("-")) {
      const operator = (tokens[at++] as Token).value;
      value = operator === "+" ? value + product(depth) : value - product(depth);
    }
    return value;
  };
  const product = (depth: number): number => {
    let value = unary(depth);
    for (;;) {
      if (isSymbol("*") || isSymbol("/")) {
        const operator = (tokens[at++] as Token).value;
        const right = unary(depth);
        value = operator === "*" ? value * right : value / right;
      } else if (peek()?.kind === "word" && peek()?.value === "of") {
        // "17% of 2340": a percentage of a number.
        at += 1;
        value *= unary(depth);
      } else return value;
    }
  };
  // A sign binds looser than `^`, as in written maths: -3^2 is -9, and 2^-1 is a half.
  const unary = (depth: number): number => {
    if (depth > MAX_DEPTH) throw new TaviError("INVALID_INPUT", "math.eval's expression nests too deeply");
    if (isSymbol("-")) {
      at += 1;
      return -unary(depth + 1);
    }
    if (isSymbol("+")) {
      at += 1;
      return unary(depth + 1);
    }
    return power(depth + 1);
  };
  const power = (depth: number): number => {
    const base = postfix(depth);
    if (!isSymbol("^")) return base;
    at += 1;
    // Right-associative: 2^3^2 is 2^9.
    return base ** unary(depth + 1);
  };
  const postfix = (depth: number): number => {
    let value = primary(depth + 1);
    while (isSymbol("%")) {
      at += 1;
      value /= 100;
    }
    return value;
  };
  const primary = (depth: number): number => {
    const token = peek();
    if (token === undefined) throw new TaviError("INVALID_INPUT", "math.eval's expression ends too soon");
    if (token.kind === "number") {
      at += 1;
      return token.value;
    }
    if (isSymbol("(")) {
      at += 1;
      const value = sum(depth);
      expect(")");
      return value;
    }
    if (token.kind === "word") {
      at += 1;
      // Own names only: `constructor` or `__proto__` must never reach the object's prototype.
      if (Object.hasOwn(CONSTANTS, token.value)) return CONSTANTS[token.value] as number;
      const fn = Object.hasOwn(FUNCTIONS, token.value) ? FUNCTIONS[token.value] : undefined;
      if (fn === undefined) throw new TaviError("INVALID_INPUT", `math.eval knows no "${token.value}"`);
      expect("(");
      const args = [sum(depth)];
      while (isSymbol(",")) {
        at += 1;
        args.push(sum(depth));
      }
      expect(")");
      return fn(...args);
    }
    throw new TaviError("INVALID_INPUT", `math.eval did not expect "${token.value}"`);
  };

  const value = sum(0);
  if (at < tokens.length) throw new TaviError("INVALID_INPUT", `math.eval did not expect "${(tokens[at] as Token).value}"`);
  return value;
}

const DateMathSchema = z.strictObject({
  from: z.string().min(1).max(40).describe('The date to start from: an ISO date or date-time (2027-03-03, 2027-03-03T09:00), or "now"'),
  add: z
    .strictObject({
      years: z.number().int().min(-10_000).max(10_000).optional(),
      months: z.number().int().min(-120_000).max(120_000).optional(),
      weeks: z.number().int().min(-520_000).max(520_000).optional(),
      days: z.number().int().min(-3_650_000).max(3_650_000).optional(),
      hours: z.number().int().min(-87_600_000).max(87_600_000).optional(),
      minutes: z.number().int().min(-5_256_000_000).max(5_256_000_000).optional(),
    })
    .optional()
    .describe("Amounts to add (negative to subtract)"),
  until: z.string().min(1).max(40).optional().describe("Another date: the result says how far it is from `from`"),
  timezone: z.string().min(1).max(64).optional().describe("The IANA time zone the dates are in (Europe/Sofia); UTC when omitted"),
});

const MathEvalInputSchema = z
  .strictObject({
    expression: z
      .string()
      .min(1)
      .max(MAX_EXPRESSION_CHARS)
      .optional()
      .describe("Arithmetic to compute: 17% of 2340, (3+9+4)/3, sqrt(2)^2, round(1234.5678, 2)"),
    date: DateMathSchema.optional().describe("Date arithmetic: a date plus or minus an amount, or the time between two dates"),
  })
  .describe("Give `expression` or `date`, not both.");

/** A date as a wall-clock time in `timezone`, read to a UTC instant. */
function instantOf(text: string, timezone: string, now: () => Date): Date {
  if (text.toLowerCase() === "now") return now();
  // A date-time with its own offset or Z is already an instant.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) && text.includes("T")) {
    const at = new Date(text);
    if (Number.isNaN(at.getTime())) throw new TaviError("INVALID_INPUT", `math.eval cannot read the date "${text}"`);
    return at;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text);
  if (match === null) throw new TaviError("INVALID_INPUT", `math.eval cannot read the date "${text}": give 2027-03-03 or 2027-03-03T09:00`);
  const [, year, month, day, hour = "0", minute = "0"] = match;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const check = new Date(wall);
  // A date that does not exist (the 31st of February) is refused, not rolled into the next month.
  if (check.getUTCDate() !== Number(day) || check.getUTCMonth() !== Number(month) - 1 || Number(hour) > 23 || Number(minute) > 59)
    throw new TaviError("INVALID_INPUT", `math.eval: ${text} is not a date`);
  return instantOfWall(wall, timezone);
}

/**
 * The instant a wall-clock time in `timezone` names (`wall` its fields read as
 * UTC). The offset is looked up at the instant itself, not at the wall time
 * read as UTC, which is an hour off near a change of clocks; a time a change
 * skips (02:30 the night clocks go forward) is read by the offset before it.
 */
function instantOfWall(wall: number, timezone: string): Date {
  const guess = wall - offsetMinutes(new Date(wall), timezone) * 60_000;
  return new Date(wall - offsetMinutes(new Date(guess), timezone) * 60_000);
}

/** How far `timezone`'s wall clock is ahead of UTC at `at`, in minutes. */
function offsetMinutes(at: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
  } catch {
    throw new TaviError("INVALID_INPUT", `math.eval knows no time zone "${timezone}"`);
  }
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return Math.round((wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** `at` as `timezone`'s wall clock, `2027-06-01T09:00` with its weekday. */
function wallClock(at: Date, timezone: string): { readonly date: string; readonly weekday: string } {
  const local = new Date(at.getTime() + offsetMinutes(at, timezone) * 60_000);
  return {
    date: local.toISOString().slice(0, 16),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(at),
  };
}

export function dateMath(input: z.infer<typeof DateMathSchema>, now: () => Date = () => new Date()): Record<string, unknown> {
  const timezone = input.timezone ?? "UTC";
  const from = instantOf(input.from, timezone, now);
  if (input.until !== undefined) {
    const until = instantOf(input.until, timezone, now);
    const minutes = Math.round((until.getTime() - from.getTime()) / 60_000);
    // Days are calendar days on the wall clock, so a day with a change of clocks still counts as one.
    const dateOf = (at: Date) => Date.parse(`${wallClock(at, timezone).date.slice(0, 10)}T00:00:00Z`);
    return {
      from: wallClock(from, timezone),
      until: wallClock(until, timezone),
      days: Math.round((dateOf(until) - dateOf(from)) / 86_400_000),
      hours: Math.trunc(minutes / 60),
      minutes,
      timezone,
    };
  }
  const add = input.add ?? {};
  // Calendar amounts move the wall clock (a month later is the same day of the month, or the month's last); clock amounts move the instant.
  const wall = new Date(from.getTime() + offsetMinutes(from, timezone) * 60_000);
  const day = wall.getUTCDate();
  wall.setUTCDate(1);
  wall.setUTCFullYear(wall.getUTCFullYear() + (add.years ?? 0));
  wall.setUTCMonth(wall.getUTCMonth() + (add.months ?? 0));
  const lastDay = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  wall.setUTCDate(Math.min(day, lastDay) + (add.weeks ?? 0) * 7 + (add.days ?? 0));
  if (Number.isNaN(wall.getTime())) throw new TaviError("INVALID_INPUT", "math.eval: the result is past the calendar's range");
  const moved = new Date(instantOfWall(wall.getTime(), timezone).getTime() + ((add.hours ?? 0) * 60 + (add.minutes ?? 0)) * 60_000);
  return { from: wallClock(from, timezone), result: wallClock(moved, timezone), timezone };
}

/** Register `math.eval`. */
export function registerMathTool(registry: ToolRegistry, now: () => Date = () => new Date()): void {
  registry.register({
    id: "math.eval",
    sink: "none",
    version: "1.0.0",
    description:
      "Compute exactly instead of estimating: arithmetic with percentages and common functions (`expression`: 17% of 2340, (3+9+4)/3, round(1234.5678, 2)), or date arithmetic in a time zone (`date`: 90 days after 2027-03-03, the time until a date). Runs no code and needs no approval. Not for statistics over a file or data set: use sandbox.run.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MathEvalInputSchema,
    handler: async ({ input }) => {
      const parsed = MathEvalInputSchema.parse(input);
      if ((parsed.expression === undefined) === (parsed.date === undefined))
        throw new TaviError("INVALID_INPUT", "math.eval takes `expression` or `date`, exactly one");
      if (parsed.date !== undefined) return dateMath(parsed.date, now);
      const value = evaluateExpression(parsed.expression as string);
      if (!Number.isFinite(value)) throw new TaviError("INVALID_INPUT", `math.eval's result is not a finite number (${value})`);
      return { expression: parsed.expression, value: Number(value.toPrecision(15)) };
    },
  });
}
