import type { PlacesSourceRecord } from "../src/index.js";

export * from "../src/index.js";

/** Records by id, as the store takes them. */
export const storeRecords = (records: readonly PlacesSourceRecord[]): ReadonlyMap<string, PlacesSourceRecord> =>
  new Map(records.map((each) => [each.id, each]));
