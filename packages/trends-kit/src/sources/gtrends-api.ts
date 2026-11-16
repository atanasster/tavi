import { GTRENDS_API } from "../records.js";
import type { TrendsAdapter } from "./types.js";

/**
 * Google's Trends API is in alpha, by application, with no
 * public reference: its requests and answers are not known, so this source
 * has a record (its terms, its key setting) and reads nothing until they
 * are.
 */
export const gtrendsApi: TrendsAdapter = {
  record: GTRENDS_API,
  unconfigured: () => "Google publishes no reference for its alpha Trends API yet: this source reads nothing until it does",
};
