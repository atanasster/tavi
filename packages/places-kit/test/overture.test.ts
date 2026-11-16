import { readFileSync } from "node:fs";
import { join } from "node:path";

import { asyncBufferFromUrl } from "hyparquet";
import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { DatabaseSync } from "node:sqlite";

import {
  boxAround,
  candidateFromOverture,
  openOverturePack,
  overtureAssetUrl,
  overtureItemsFor,
  planMatches,
  planQuery,
  readOvertureBox,
  rowGroupBoxes,
  rowRangesFor,
  writeOverturePack,
  type RowGroupBox,
} from "../src/index.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** Recorded 2026-10-17 from release 2026-09-23.1: the STAC collection and item 00001, rows decoded from part-00001, and its row groups' bbox statistics. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(domainFixtures("places"), "overture", name), "utf8"));
const austin = { west: -97.78, south: 30.24, east: -97.7, north: 30.3 };

describe("the Overture area pack", () => {
  it("reads only the files whose extents meet the area, from STAC", () => {
    const items = overtureItemsFor(fixture("stac-collection-2026-09-23.1.json"), austin);
    expect(items).toEqual(["https://stac.overturemaps.org/2026-09-23.1/places/place/00001/00001.json"]);
    expect(
      overtureItemsFor({ extent: { spatial: { bbox: [[0, 0, 1, 1]] } }, links: [{ rel: "item", href: "x" }] }, austin),
    ).toBeUndefined();
    expect(overtureAssetUrl(fixture("stac-item-00001.json"))).toBe(
      "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-09-23.1/theme=places/type=place/part-00001-947ef15d-91bf-56dd-a6a3-aad846cc7a28-c000.zstd.parquet",
    );
    // Only Overture's S3 bucket: the Azure mirror, or any other host, is never fetched.
    expect(
      overtureAssetUrl({
        assets: {
          azure: { href: "https://overturemapswestus2.blob.core.windows.net/x.parquet" },
          evil: { href: "https://evil.example/x.parquet" },
        },
      }),
    ).toBeUndefined();
  });

  it("reads only the row groups whose statistics meet the area: 4 of 512 for Austin", () => {
    const groups = (
      fixture("row-groups-part-00001.json") as { num_rows: number; columns: { path: string; min: number; max: number }[] }[]
    ).map((group): RowGroupBox => {
      const stat = (path: string, side: "min" | "max") => group.columns.find((column) => column.path === path)?.[side] as number;
      return {
        rows: group.num_rows,
        xmin: stat("bbox.xmin", "min"),
        xmax: stat("bbox.xmax", "max"),
        ymin: stat("bbox.ymin", "min"),
        ymax: stat("bbox.ymax", "max"),
      };
    });
    expect(groups).toHaveLength(512);
    expect(rowRangesFor(groups, austin)).toHaveLength(4);
    // A group without statistics is read rather than skipped.
    expect(rowRangesFor([{ rows: 10 }, { rows: 5, xmin: 0, xmax: 1, ymin: 0, ymax: 1 }], austin)).toEqual([[0, 10]]);
  });

  it("reads the bbox statistics hyparquet gives a row group, and leaves a missing one unknown", () => {
    const column = (path: string, min: number, max: number) => ({
      meta_data: { path_in_schema: path.split("."), statistics: { min_value: min, max_value: max } },
    });
    const groups = rowGroupBoxes({
      row_groups: [
        {
          num_rows: 10n,
          columns: [
            column("bbox.xmin", -97.9, -97.7),
            column("bbox.xmax", -97.8, -97.6),
            column("bbox.ymin", 30.1, 30.2),
            column("bbox.ymax", 30.2, 30.3),
            column("id", 0, 0),
          ],
        },
        { num_rows: 4n, columns: [{ meta_data: { path_in_schema: ["bbox", "xmin"], statistics: { min: -1, max: 1 } } }] },
      ],
    } as never);
    expect(groups).toEqual([
      { rows: 10, xmin: -97.9, xmax: -97.6, ymin: 30.1, ymax: 30.3 },
      { rows: 4, xmin: -1 },
    ]);
    expect(rowRangesFor(groups, austin)).toEqual([
      [0, 10],
      [10, 14],
    ]);
  });

  it("reads each record as a candidate under its sources' licences, its closure as a status", () => {
    const rows = fixture("austin-rows.json") as unknown[];
    const candidates = rows.map(candidateFromOverture).filter((candidate) => candidate !== undefined);
    expect(candidates.length).toBe(rows.length);
    const tailor = candidates.find((candidate) => candidate.name === "Ace Tailors");
    expect(tailor).toMatchObject({ source: "overture", categories: ["sewing and alterations", "home service"], country: "US" });
    expect(tailor?.licence).toMatch(/CDLA-Permissive-2\.0/);
    expect(tailor?.attribution).toMatch(/^Overture Maps Foundation/);
    expect(candidates.some((candidate) => candidate.status === "permanently_closed")).toBe(true);
    expect(candidateFromOverture({ id: "x", bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } })).toBeUndefined();
    // One odd record is passed over, never thrown: a blank name, a name past the bound.
    expect(candidateFromOverture({ id: "x", names: { primary: "  " }, bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } })).toBeUndefined();
    expect(candidateFromOverture({ id: "x", names: { primary: "A" }, bbox: { xmin: 0, xmax: 0, ymin: 999, ymax: 999 } })).toBeUndefined();
    expect(
      candidateFromOverture({
        id: "x",
        names: { primary: "A" },
        taxonomy: { primary: "z".repeat(200) },
        bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 },
      })?.categories[0],
    ).toHaveLength(80);
  });

  it("answers a plan from the pack by its own categories or its names, nearest first, and refuses a pack never written", () => {
    const dir = directories.create("overture-pack-");
    const candidates = (fixture("austin-rows.json") as unknown[]).map(candidateFromOverture).filter((candidate) => candidate !== undefined);
    const path = join(dir, "pack.db");
    expect(
      writeOverturePack(path, { release: "2026-09-23.1", box: austin, builtAt: "2026-10-17T12:00:00Z" }, [
        ...candidates,
        ...candidates.slice(0, 2),
      ]),
    ).toBe(candidates.length);
    const pack = openOverturePack(path);
    try {
      expect(pack.meta).toMatchObject({ release: "2026-09-23.1", places: candidates.length });
      const tailors = pack.near({ lat: 30.27, lon: -97.74 }, 10, planQuery("tailor"), 5);
      expect(tailors.map((candidate) => candidate.name)).toContain("Ace Tailors");
      expect(tailors.every((candidate) => /alteration|tailor/i.test(candidate.categories.join(" ")))).toBe(true);
      expect(pack.near({ lat: 30.27, lon: -97.74 }, 10, planQuery("vet"), 5).length).toBeGreaterThan(0);
      // A source's own category names, narrowly: Overture's automotive_repair is car repair, its garage_door_service and automotive_service are not.
      expect(planMatches(planQuery("garage"), { name: "A", categories: ["automotive repair", "automotive service"] })).toBe(true);
      expect(planMatches(planQuery("garage"), { name: "A", categories: ["garage door service", "home service"] })).toBe(false);
      expect(planMatches(planQuery("mechanic"), { name: "A", categories: ["parking garage", "automotive service"] })).toBe(false);
      // A plan with no category matches on every remaining word of the name.
      expect(planMatches(planQuery("Ace"), { name: "Ace Tailors", categories: [] })).toBe(true);
      expect(planMatches(planQuery("Ace Bakers"), { name: "Ace Tailors", categories: [] })).toBe(false);
    } finally {
      pack.close();
    }
    writeOverturePack(join(dir, "empty.db"), { release: "x", box: austin, builtAt: "2026-10-17T12:00:00Z" }, []);
    const empty = openOverturePack(join(dir, "empty.db"));
    expect(empty.near({ lat: 30.27, lon: -97.74 }, 10, planQuery("vet"), 5)).toEqual([]);
    empty.close();
    // A file with the schema but no pack row (a build cut short) is refused.
    writeOverturePack(join(dir, "torn.db"), { release: "x", box: austin, builtAt: "2026-10-17T12:00:00Z" }, []);
    const torn = new DatabaseSync(join(dir, "torn.db"));
    torn.exec("DELETE FROM pack");
    torn.close();
    expect(() => openOverturePack(join(dir, "torn.db"))).toThrow(/build it again/);
  });
});

describe.skipIf(process.env["TAVI_LIVE"] !== "1")("the Overture pack, live from S3", () => {
  it("reads a small box of Austin by range, within its budget", { timeout: 120_000 }, async () => {
    const url = overtureAssetUrl(fixture("stac-item-00001.json")) as string;
    const file = await asyncBufferFromUrl({ url });
    const read = await readOvertureBox(file, boxAround({ lat: 30.27, lon: -97.74 }, 2));
    expect(read.rowGroups).toBeLessThanOrEqual(8);
    expect(read.candidates.length).toBeGreaterThan(1_000);
  });
});
