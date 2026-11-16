import type { Salary } from "./contracts.js";

/**
 * Pay as a posting states it, and as a year's pay to compare with a floor:
 * 2,080 hours, 260 days, 52 weeks or 12 months a year, plus any
 * extra months. Currencies are never converted here (matching converts at dated ECB rates).
 */
const PER_YEAR: Readonly<Record<Salary["period"], number>> = { HOUR: 2_080, DAY: 260, WEEK: 52, MONTH: 12, YEAR: 1 };

/** A salary's range as a year's pay, in its own currency. */
export function annualise(salary: Salary): { readonly currency: string; readonly min?: number; readonly max?: number } {
  const factor = PER_YEAR[salary.period] + (salary.period === "MONTH" ? (salary.extraMonths ?? 0) : 0);
  return {
    currency: salary.currency,
    ...(salary.min === undefined ? {} : { min: salary.min * factor }),
    ...(salary.max === undefined ? {} : { max: salary.max * factor }),
  };
}

/** A floor (`amount` a `period`) as a year's pay. */
export function annualFloor(floor: { readonly amount: number; readonly period: Salary["period"] }): number {
  return floor.amount * PER_YEAR[floor.period];
}

const SYMBOLS: Readonly<Record<string, string>> = {
  $: "USD",
  US$: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  C$: "CAD",
  CA$: "CAD",
  A$: "AUD",
  AU$: "AUD",
  NZ$: "NZD",
  S$: "SGD",
  CHF: "CHF",
  kr: "SEK",
  zł: "PLN",
};
const CODES = new Set([
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "SGD",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "INR",
  "JPY",
  "BRL",
  "MXN",
  "ZAR",
  "AED",
  "ILS",
  "HKD",
]);

const PERIOD_WORDS: readonly (readonly [RegExp, Salary["period"]])[] = [
  [/(?:\b(?:per|an?)\s+|\/\s*)(?:hour|hr|h)\b|\bhourly\b|\bstündlich\b/i, "HOUR"],
  [/(?:\b(?:per|a)\s+|\/\s*)day\b|\bdaily\b|\bday rate\b/i, "DAY"],
  [/(?:\b(?:per|a)\s+|\/\s*)(?:week|wk)\b|\bweekly\b/i, "WEEK"],
  [/(?:\b(?:per|a)\s+|\/\s*)(?:month|mo)\b|\bmonthly\b|\bmonatlich\b|\bmensuel\b/i, "MONTH"],
  [/(?:\b(?:per|a|an)\s+|\/\s*)(?:year|annum|yr)\b|\bannual(?:ly)?\b|\bp\.\s?a\.|\bjährlich\b|\bper anno\b/i, "YEAR"],
];

/** Words that say a figure is pay, before it or after it; a figure with none is not read as a salary ("raised $50M"). */
const PAY_WORDS =
  /\b(salary|salaries|pay|paid|compensation|comp|base|range|wage|wages|rate|ote|earn|earning|gehalt|vergütung|lohn|salaire|rémunération|sueldo|salario|stipendio|lön|lønn)\b/i;

/** The period whose words come first in `text`, if any do. */
export function salaryPeriodIn(text: string): Salary["period"] | undefined {
  let first: { readonly at: number; readonly period: Salary["period"] } | undefined;
  for (const [words, period] of PERIOD_WORDS) {
    const at = words.exec(text)?.index;
    if (at !== undefined && (first === undefined || at < first.at)) first = { at, period };
  }
  return first?.period;
}

/** One amount as written: "120,000", "120.000", "120k", "1.2m". */
function amountOf(text: string): number | undefined {
  const match = /^(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*([km])?$/i.exec(text.trim());
  if (match === null) return undefined;
  const [, digits = "", unit] = match;
  // Groups of three after a separator are thousands; one or two digits after it are a decimal.
  const grouped = /[.,\s]\d{3}(?:$|[.,\s])/.test(digits) && !/[.,]\d{1,2}$/.test(digits);
  const value = grouped ? Number(digits.replace(/[.,\s]/g, "")) : Number(digits.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return unit === undefined ? value : value * (unit.toLowerCase() === "k" ? 1_000 : 1_000_000);
}

/**
 * The first pay range a posting's text states: "$120,000 – $150,000 a year",
 * "€60k-80k", "£45,000 per annum", "$50/hour", "EUR 5.000 brutto monatlich".
 * Its origin is `text`, so a floor never relies on it.
 */
export function salaryFromText(text: string): Salary | undefined {
  const pattern = new RegExp(SALARY_PATTERN.source, "gi");
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const salary = salaryOf(text, match);
    if (salary !== undefined) return salary;
  }
  return undefined;
}

const SALARY_PATTERN =
  /(US\$|CA\$|AU\$|NZ\$|C\$|A\$|S\$|[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|SGD|CHF|SEK|NOK|DKK|PLN|CZK|INR|JPY|BRL|MXN|ZAR|AED|ILS|HKD)\b)\s?(\d[\d.,\s]{0,12}\d?\s?[km]?)(?:\s*(?:-|–|—|to|bis|à)\s*(?:US\$|CA\$|AU\$|NZ\$|C\$|A\$|S\$|[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|SGD|CHF|SEK|NOK|DKK|PLN|CZK|INR|JPY|BRL|MXN|ZAR|AED|ILS|HKD)\b)?\s?(\d[\d.,\s]{0,12}\d?\s?[km]?))?/i;

/** The pay one match states, when the words around it say it is pay. */
function salaryOf(text: string, match: RegExpExecArray): Salary | undefined {
  const [whole, mark = "", first = "", second] = match;
  const currency = CODES.has(mark.toUpperCase()) ? mark.toUpperCase() : SYMBOLS[mark];
  if (currency === undefined) return undefined;
  let min = amountOf(first);
  let max = second === undefined ? undefined : amountOf(second);
  // A unit written on one end covers both: "€60-80k" and "€60k-80".
  if (min !== undefined && max !== undefined && /k$/i.test(second?.trim() ?? "") && !/k$/i.test(first.trim()) && min < 1_000) min *= 1_000;
  if (min !== undefined && max !== undefined && /k$/i.test(first.trim()) && !/k$/i.test(second?.trim() ?? "") && max < 1_000) max *= 1_000;
  if (min === undefined || min === 0) return undefined;
  if (max !== undefined && max < min) max = undefined;
  const end = match.index + whole.length;
  const after = text.slice(end, end + 40);
  // A company's funding or revenue, not pay.
  if (/^\s*(?:m|mm|b|bn|million|billion|mio|mrd)\b/i.test(after)) return undefined;
  // The period in the amount's own clause: "$120,000 base, in the office 2 days a week" is a year's pay.
  const said = salaryPeriodIn(after.split(/[,;(]|\.\s/)[0] ?? "");
  if (said === undefined && !PAY_WORDS.test(text.slice(Math.max(0, match.index - 60), match.index))) return undefined;
  const period = said ?? (min < 300 ? "HOUR" : min < 20_000 ? "MONTH" : "YEAR");
  // ".NET" is a framework, not net pay.
  const basis = /(?<![.\w])net(?:to)?\b/i.test(after) ? "net" : /\b(gross|brutto)\b/i.test(after) ? "gross" : "unknown";
  // A range the text gives as pay, its period written beside it ("Pay range: $38.87 - $54.42 per hour"), is
  // stated, as a source's own field is; a lone figure, or a period guessed from its size, is only read.
  const stated = max !== undefined && said !== undefined && PAY_WORDS.test(text.slice(Math.max(0, match.index - 60), match.index));
  return { currency, min, ...(max === undefined ? {} : { max }), period, basis, origin: stated ? "stated" : "text" };
}
