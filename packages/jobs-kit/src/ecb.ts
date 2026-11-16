import { childOf, childrenOf, parseXml } from "./xml.js";

/**
 * The ECB's euro reference rates: a day's rates, so a stated
 * salary in another currency can be held against a floor. Converted at the
 * day's rate, never guessed: a currency the ECB does not quote is unknown.
 */
export interface EuroRates {
  /** The rates' day, `YYYY-MM-DD`. */
  readonly date: string;
  /** Units of each currency per euro; `EUR` is 1. */
  readonly perEuro: Readonly<Record<string, number>>;
}

export const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** The daily reference rates file as rates, or `undefined` when it is not one. */
export function parseEcbRates(xml: string): EuroRates | undefined {
  const envelope = childOf(parseXml(xml), "Envelope");
  const day = childrenOf(childOf(envelope, "Cube"), "Cube").find((cube) => /^\d{4}-\d{2}-\d{2}$/.test(cube.attributes["time"] ?? ""));
  if (day === undefined) return undefined;
  const perEuro: Record<string, number> = { EUR: 1 };
  for (const cube of childrenOf(day, "Cube")) {
    const currency = cube.attributes["currency"];
    const rate = Number(cube.attributes["rate"]);
    if (currency !== undefined && /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0) perEuro[currency] = rate;
  }
  return Object.keys(perEuro).length > 1 ? { date: day.attributes["time"] ?? "", perEuro } : undefined;
}

/** `amount` in `from` as `to`, or `undefined` when either currency is not quoted. */
export function convertCurrency(amount: number, from: string, to: string, rates: EuroRates): number | undefined {
  if (from === to) return amount;
  const fromRate = rates.perEuro[from];
  const toRate = rates.perEuro[to];
  return fromRate === undefined || toRate === undefined ? undefined : (amount / fromRate) * toRate;
}
