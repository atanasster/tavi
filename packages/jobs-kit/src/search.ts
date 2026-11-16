import type { JobPosting, JobQuery } from "./contracts.js";
import { regionCovers } from "./places.js";

/**
 * Whether a posting answers a query (`search`): an employer's board lists
 * all its jobs, so the worker keeps the ones the query asks for. A field the
 * posting leaves unknown never excludes it here; matching decides
 * against the person's profile, with its own rules.
 */
export function postingAnswersQuery(
  posting: JobPosting,
  description: string,
  query: Pick<JobQuery, "keywords" | "countries" | "workplace" | "postedWithinDays">,
  now: string,
): boolean {
  const title = posting.title.toLowerCase();
  const text = `${title}\n${description.toLowerCase()}`;
  const keywords = query.keywords.map((keyword) => keyword.toLowerCase().trim()).filter((keyword) => keyword !== "");
  // A keyword is in the title as written, or each of its words is somewhere in the posting.
  if (
    keywords.length > 0 &&
    !keywords.some((keyword) => wordIn(title, keyword) || keyword.split(/\s+/).every((word) => wordIn(text, word)))
  )
    return false;
  if (query.countries.length > 0) {
    const countries = posting.places.map((place) => place.country).filter((country): country is string => country !== undefined);
    const regions = posting.remoteRegions ?? [];
    const placed = countries.length > 0 || regions.length > 0;
    if (
      placed &&
      !countries.some((country) => query.countries.includes(country)) &&
      !regions.some((region) => query.countries.some((country) => regionCovers(region, country)))
    )
      return false;
  }
  if (
    query.workplace !== undefined &&
    query.workplace.length > 0 &&
    posting.workplace !== "unknown" &&
    !query.workplace.includes(posting.workplace)
  )
    return false;
  if (posting.postedAt !== undefined && Date.parse(now) - Date.parse(posting.postedAt) > query.postedWithinDays * 86_400_000) return false;
  return true;
}

/** Whether `word` stands as a word in `text` (so "go" is not found in "google"). */
function wordIn(text: string, word: string): boolean {
  let at = text.indexOf(word);
  while (at !== -1) {
    const before = text[at - 1];
    const after = text[at + word.length];
    if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}
