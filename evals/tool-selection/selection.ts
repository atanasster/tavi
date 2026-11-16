/**
 * The offline tool-selection eval: for each everyday request, does the
 * lexical ranking a turn uses (`tools.search`'s `discoverTools`, the router's
 * `shortlistTools` fallback) put a tool that serves it near the top? It reads
 * only the registered tools' ids and descriptions, so it is deterministic and
 * free to run, and it gates changes to descriptions and to the rankers.
 */

export interface SelectionCase {
  readonly id: string;
  readonly query: string;
  /** Any one of these serves the request. */
  readonly expected: readonly string[];
}

export interface SelectionCasesFile {
  readonly version: 1;
  readonly cases: readonly SelectionCase[];
}

export interface SelectionReport {
  readonly cases: number;
  /** Share of cases whose first discovered tool serves the request. */
  readonly recallAt1: number;
  /** Share of cases with a serving tool among the first five discovered. */
  readonly recallAt5: number;
  /** Share of cases with a serving tool on the router's lexical shortlist. */
  readonly shortlistRecall: number;
  /** Case ids whose top five held no serving tool. */
  readonly missedAt5: readonly string[];
}

export interface SelectionRankers {
  /** Tool ids in ranked order, at most eight. */
  readonly discover: (query: string) => readonly string[];
  /** The ids a router-off shortlist offers for `query`. */
  readonly shortlist: (query: string) => readonly string[];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export function runSelectionEval(cases: readonly SelectionCase[], rankers: SelectionRankers): SelectionReport {
  let at1 = 0;
  let at5 = 0;
  let listed = 0;
  const missedAt5: string[] = [];
  for (const entry of cases) {
    const serves = (id: string) => entry.expected.includes(id);
    const ranked = rankers.discover(entry.query);
    if (ranked[0] !== undefined && serves(ranked[0])) at1 += 1;
    if (ranked.slice(0, 5).some(serves)) at5 += 1;
    else missedAt5.push(entry.id);
    if (rankers.shortlist(entry.query).some(serves)) listed += 1;
  }
  const share = (count: number) => (cases.length === 0 ? 0 : round(count / cases.length));
  return { cases: cases.length, recallAt1: share(at1), recallAt5: share(at5), shortlistRecall: share(listed), missedAt5 };
}
