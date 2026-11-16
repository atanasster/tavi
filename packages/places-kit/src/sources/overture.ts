import { definedOnly } from "@tavi/contracts/util";
import type { AsyncBuffer, FileMetaData } from "hyparquet";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { z } from "zod";

import { CandidateSchema, PlacesSourceRecordSchema, type Candidate } from "../contracts.js";
import type { BoundingBox } from "../geo.js";

/**
 * Overture Maps' places: about 81M places in
 * monthly GeoParquet releases, each record under its own source's licence
 * (CDLA-Permissive-2.0, Apache-2.0, CC0). The person picks an area; the
 * worker reads only the row groups whose bounding boxes meet it, by HTTP
 * range, into an area pack in its cache. Measured on 2026-10-17 for an 8 × 7
 * km box of Austin: one file of 16, 4 row groups of 512, about 11 MB read in
 * 7 s, 20,869 places.
 */
export const OVERTURE_STAC = "https://stac.overturemaps.org/catalog.json";
/** The S3 host Overture's assets are on; the Azure mirror is not used. */
export const OVERTURE_S3_HOST = "overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
/** The widest area one pack covers, either way from its centre. */
export const OVERTURE_PACK_MAX_KM = 25;

export const overtureRecord = PlacesSourceRecordSchema.parse({
  id: "overture",
  name: "Overture Maps (places)",
  countries: ["*"],
  hosts: ["stac.overturemaps.org", OVERTURE_S3_HOST],
  auth: "none",
  terms: {
    url: "https://docs.overturemaps.org/attribution/",
    reviewedAt: "2026-10-17",
    licence: "CDLA-Permissive-2.0, Apache-2.0, CC0",
    llmUse: "allowed",
    cache: { mode: "keep" },
    attribution: "Overture Maps Foundation; places from Meta, Microsoft, Foursquare and others",
    displayRules: ["Credit Overture Maps Foundation and each place's source dataset"],
    // Building a pack is the person's choice of area, never a sweep's.
    userTriggeredOnly: true,
  },
  // One pack build counts once, however many range reads it makes.
  budget: { perSecond: 0.1, perDay: 4 },
  kind: "poi",
  precisionDecimals: 2,
  fields: ["phone", "website", "status"],
});

const CollectionSchema = z.looseObject({
  extent: z.looseObject({ spatial: z.looseObject({ bbox: z.array(z.array(z.number()).length(4)).min(2) }) }),
  links: z.array(z.looseObject({ rel: z.string(), href: z.string() })),
});

const meets = (a: BoundingBox, b: readonly number[]): boolean =>
  (b[0] ?? Infinity) <= a.east && (b[2] ?? -Infinity) >= a.west && (b[1] ?? Infinity) <= a.north && (b[3] ?? -Infinity) >= a.south;

/**
 * The STAC items whose files meet `box`: the collection's extents list the
 * whole first, then one per item in the order its item links appear.
 */
export function overtureItemsFor(collection: unknown, box: BoundingBox): string[] | undefined {
  const parsed = CollectionSchema.safeParse(collection);
  if (!parsed.success) return undefined;
  const items = parsed.data.links.filter((link) => link.rel === "item").map((link) => link.href);
  const extents = parsed.data.extent.spatial.bbox.slice(1);
  if (items.length !== extents.length) return undefined;
  return items.filter((_, index) => meets(box, extents[index] ?? []));
}

const ItemSchema = z.looseObject({ assets: z.record(z.string(), z.looseObject({ href: z.string() })) });

/** An item's file on Overture's S3 bucket, or `undefined`. */
export function overtureAssetUrl(item: unknown): string | undefined {
  const parsed = ItemSchema.safeParse(item);
  if (!parsed.success) return undefined;
  return Object.values(parsed.data.assets)
    .map((asset) => asset.href)
    .find((href) => {
      try {
        const url = new URL(href);
        return url.protocol === "https:" && url.hostname === OVERTURE_S3_HOST && url.pathname.endsWith(".parquet");
      } catch {
        return false;
      }
    });
}

/** One row group's place in the file and its bounding-box statistics. */
export interface RowGroupBox {
  readonly rows: number;
  readonly xmin?: number;
  readonly xmax?: number;
  readonly ymin?: number;
  readonly ymax?: number;
}

/** Each row group's rows and the min and max of its places' `bbox` columns. */
export function rowGroupBoxes(metadata: Pick<FileMetaData, "row_groups">): RowGroupBox[] {
  return metadata.row_groups.map((group) => {
    const stat = (path: string, side: "min" | "max"): number | undefined => {
      const statistics = group.columns.find((column) => column.meta_data?.path_in_schema.join(".") === path)?.meta_data?.statistics;
      const value = side === "min" ? (statistics?.min_value ?? statistics?.min) : (statistics?.max_value ?? statistics?.max);
      return typeof value === "number" ? value : undefined;
    };
    const xmin = stat("bbox.xmin", "min");
    const xmax = stat("bbox.xmax", "max");
    const ymin = stat("bbox.ymin", "min");
    const ymax = stat("bbox.ymax", "max");
    return { rows: Number(group.num_rows), ...definedOnly({ xmin, xmax, ymin, ymax }) };
  });
}

/** The row ranges of the groups whose places can meet `box`; a group without statistics is read, not skipped. */
export function rowRangesFor(groups: readonly RowGroupBox[], box: BoundingBox): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (const group of groups) {
    const { xmin, ymin, xmax, ymax } = group;
    if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined || meets(box, [xmin, ymin, xmax, ymax]))
      ranges.push([start, start + group.rows]);
    start += group.rows;
  }
  return ranges;
}

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const RowSchema = z.looseObject({
  id: z.string().min(1),
  names: z.looseObject({ primary: optionalText }).nullish(),
  basic_category: optionalText,
  taxonomy: z.looseObject({ primary: optionalText }).nullish(),
  confidence: z.number().nullish(),
  operating_status: optionalText,
  websites: z.array(z.string()).nullish(),
  phones: z.array(z.string()).nullish(),
  addresses: z
    .array(z.looseObject({ freeform: optionalText, locality: optionalText, postcode: optionalText, country: optionalText }))
    .nullish(),
  bbox: z.looseObject({ xmin: z.number(), xmax: z.number(), ymin: z.number(), ymax: z.number() }),
  brand: z.looseObject({ names: z.looseObject({ primary: optionalText }).nullish() }).nullish(),
  sources: z.array(z.looseObject({ dataset: optionalText, license: optionalText, update_time: optionalText })).nullish(),
});

/** The columns a pack reads; the rest of a record is left on S3. */
export const OVERTURE_COLUMNS = [
  "id",
  "names",
  "basic_category",
  "taxonomy",
  "confidence",
  "operating_status",
  "websites",
  "phones",
  "addresses",
  "bbox",
  "brand",
  "sources",
] as const;

const STATUSES: ReadonlyMap<string, Candidate["status"]> = new Map([
  ["open", "open"],
  ["temporarily_closed", "temporarily_closed"],
  ["permanently_closed", "permanently_closed"],
]);

/** An Overture record as a candidate, under its sources' licences; `undefined` for one without a name or that does not fit, so one odd record never stops a pack. */
export function candidateFromOverture(row: unknown): Candidate | undefined {
  const parsed = RowSchema.safeParse(row);
  const name = parsed.success ? parsed.data.names?.primary?.trim() : undefined;
  if (!parsed.success || name === undefined || name === "") return undefined;
  const record = parsed.data;
  const datasets = [
    ...new Set(
      (record.sources ?? [])
        .map((source) => source.dataset)
        .filter((dataset): dataset is string => dataset !== undefined && !dataset.startsWith("Overture")),
    ),
  ];
  const licences = [
    ...new Set((record.sources ?? []).map((source) => source.license).filter((licence): licence is string => licence !== undefined)),
  ].sort();
  const updates = (record.sources ?? [])
    .map((source) => (source.update_time === undefined ? Number.NaN : Date.parse(source.update_time)))
    .filter((ms) => Number.isFinite(ms));
  const address = record.addresses?.[0];
  const street = [address?.freeform, address?.locality].filter((part) => part !== undefined && part !== "").join(", ");
  const categories = [record.taxonomy?.primary, record.basic_category]
    .filter((category): category is string => category !== undefined && category !== "")
    .map((category) => category.replace(/_/g, " ").slice(0, 80));
  const candidate = CandidateSchema.safeParse({
    source: "overture",
    sourceId: record.id,
    licence: (licences.join(", ") || "CDLA-Permissive-2.0").slice(0, 60),
    attribution: `Overture Maps Foundation${datasets.length === 0 ? "" : ` (${datasets.join(", ")})`}`.slice(0, 200),
    name: name.slice(0, 200),
    categories: [...new Set(categories)].slice(0, 8),
    ...(street === "" ? {} : { address: street.slice(0, 300) }),
    ...(address?.postcode === undefined ? {} : { postcode: address.postcode.slice(0, 20) }),
    ...(address?.country !== undefined && /^[A-Z]{2}$/.test(address.country) ? { country: address.country } : {}),
    lat: (record.bbox.ymin + record.bbox.ymax) / 2,
    lon: (record.bbox.xmin + record.bbox.xmax) / 2,
    ...(record.phones?.[0] === undefined ? {} : { phone: record.phones[0].slice(0, 60) }),
    ...(record.websites?.[0] === undefined ? {} : { website: record.websites[0].slice(0, 2_048) }),
    status: STATUSES.get(record.operating_status ?? "") ?? "unknown",
    ...(record.confidence === null || record.confidence === undefined ? {} : { confidence: Math.min(1, Math.max(0, record.confidence)) }),
    ...(record.brand?.names?.primary === undefined ? {} : { brand: record.brand.names.primary.slice(0, 120) }),
    ...(updates.length === 0 ? {} : { checkedAt: new Date(Math.max(...updates)).toISOString() }),
  });
  return candidate.success ? candidate.data : undefined;
}

/** A remote Parquet file read by range: what `readOvertureBox` reads. */
export type ParquetFile = AsyncBuffer;

/** What one file gave for a box: the places in it, and what reading them cost. */
export interface OvertureRead {
  readonly candidates: readonly Candidate[];
  readonly rowGroups: number;
  readonly rowsRead: number;
}

/** The places of one Overture file that fall in `box`: its footer, then only the row groups that can meet it, then each place's own box. */
export async function readOvertureBox(file: AsyncBuffer, box: BoundingBox): Promise<OvertureRead> {
  const metadata = await parquetMetadataAsync(file);
  const ranges = rowRangesFor(rowGroupBoxes(metadata), box);
  const candidates: Candidate[] = [];
  let rowsRead = 0;
  for (const [rowStart, rowEnd] of ranges) {
    const rows = await parquetReadObjects({ file, metadata, columns: [...OVERTURE_COLUMNS], rowStart, rowEnd, compressors });
    rowsRead += rows.length;
    for (const row of rows) {
      const record = row as {
        readonly bbox?: { readonly xmin: number; readonly xmax: number; readonly ymin: number; readonly ymax: number };
      };
      if (record.bbox === undefined || !meets(box, [record.bbox.xmin, record.bbox.ymin, record.bbox.xmax, record.bbox.ymax])) continue;
      const candidate = candidateFromOverture(row);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }
  return { candidates, rowGroups: ranges.length, rowsRead };
}
