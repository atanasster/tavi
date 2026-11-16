import { inflateRawSync } from "node:zlib";

/**
 * The first sheet of an XLSX workbook as rows of cell text, for a source
 * that publishes only a spreadsheet (the EU's Weekly Oil Bulletin). A
 * workbook is a zip of XML parts: this reads only the parts a sheet's values
 * need, each held to `PART_MAX_BYTES` unpacked, and no formula, style or
 * macro. `undefined` when it is not a workbook Tavi can read.
 */

/** The most one part may unpack to: a sheet of a few hundred cells is tens of kilobytes. */
const PART_MAX_BYTES = 4 * 1024 * 1024;
/** Rows and columns read at most. */
const ROWS_MAX = 2_000;
const COLUMNS_MAX = 64;

/** A zip's entries by name, read from its central directory: method, sizes and where each one's data starts. */
function zipEntries(zip: Uint8Array): Map<string, { readonly method: number; readonly size: number; readonly offset: number }> | undefined {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is in the last 64 KiB and 22 bytes.
  let end = -1;
  for (let at = zip.byteLength - 22; at >= Math.max(0, zip.byteLength - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > zip.byteLength || view.getUint32(at, true) !== 0x02014b50) return undefined;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (local + 30 > zip.byteLength || view.getUint32(local, true) !== 0x04034b50) return undefined;
    const offset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(name, { method, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One part's text: stored or deflated, never more than `PART_MAX_BYTES` unpacked. */
function partText(zip: Uint8Array, entries: ReturnType<typeof zipEntries>, name: string): string | undefined {
  const entry = entries?.get(name);
  if (entry === undefined || entry.offset + entry.size > zip.byteLength) return undefined;
  const data = zip.subarray(entry.offset, entry.offset + entry.size);
  try {
    if (entry.method === 0) return data.byteLength > PART_MAX_BYTES ? undefined : new TextDecoder("utf-8").decode(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: PART_MAX_BYTES }).toString("utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** XML text with its entities read. */
const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name] ?? whole;
    const code = name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    // A reference past Unicode is left as written, never thrown on.
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
/** Every `<t>` run inside an element, joined: a shared or inline string, rich text included. */
const runs = (xml: string): string =>
  unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => match[1] ?? "").join(""));

/** A cell reference's column as an index: "A" is 0, "AB" is 27. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/.exec(reference)?.[0] ?? "") index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The first sheet's rows, each cell its text (a number as written in the file); an empty cell is "". */
export function readXlsxRows(bytes: Uint8Array): string[][] | undefined {
  const entries = zipEntries(bytes);
  if (entries === undefined) return undefined;
  // The workbook's first sheet, by its relationship; `sheet1.xml` when the workbook does not say.
  const workbook = partText(bytes, entries, "xl/workbook.xml") ?? "";
  const relations = partText(bytes, entries, "xl/_rels/workbook.xml.rels") ?? "";
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target =
    firstId === undefined
      ? undefined
      : new RegExp(`<Relationship\\b[^>]*\\bId="${firstId.replace(/[^\w-]/g, "")}"[^>]*\\bTarget="([^"]+)"`).exec(relations)?.[1];
  const sheetName = target === undefined ? "xl/worksheets/sheet1.xml" : target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const sheet = partText(bytes, entries, sheetName);
  if (sheet === undefined) return undefined;
  const shared = [...(partText(bytes, entries, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    runs(match[1] ?? ""),
  );
  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= ROWS_MAX) break;
    const cells: string[] = [];
    for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? "";
      const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? "");
      if (column < 0 || column >= COLUMNS_MAX) continue;
      const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1];
      const inner = cell[2] ?? "";
      const value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      const text = type === "s" ? (shared[Number(value)] ?? "") : type === "inlineStr" ? runs(inner) : value;
      while (cells.length < column) cells.push("");
      cells[column] = text;
    }
    rows.push(cells);
  }
  return rows;
}

/** An Excel date serial (days since 1899-12-30) as an ISO date, or `undefined` for one that is not a date. */
export function excelDate(serial: string | undefined): string | undefined {
  const days = Number(serial);
  if (!Number.isFinite(days) || days < 20_000 || days > 80_000) return undefined;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(days) * 86_400_000).toISOString().slice(0, 10);
}
