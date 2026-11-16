import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { createPdfService, fillFonts, type PdfOcrAssets, type PdfRunResult, type PdfService } from "@tavi/plugin-pdf/host";

// Loaded by URL: Node runs these files as they are, so the import names the `.ts` file, which a static
// import may not (`allowImportingTsExtensions` is off); the type comes from the module itself.
const { FIXTURES, PRINTED_TEXT, buildFixture } = (await import(
  new URL("./build-fixtures.ts", import.meta.url).href
)) as typeof import("./build-fixtures.js");

/**
 * The PDF eval: every fixture
 * through the owner's PDF service and the built, single-use child, checked
 * against `manifest.json`, with what each cost (wall time, the child's peak
 * resident set) and the suite's metrics.
 *
 * `node evals/pdf/eval.ts [--fixture a,b] [--label name] [--out dir]`
 * writes `results/<label>.json` and exits 0 when every fixture passed. A
 * mismatch on a fixture marked `pending` is reported as pending: what it
 * names closes it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface FillExpectation {
  readonly values: readonly { readonly field: string; readonly value: string | boolean | readonly string[] }[];
  readonly expect: "ok" | "answerSheet" | { readonly refused: string };
  readonly leftUserOnly?: readonly string[];
  readonly outputActiveContent?: readonly string[];
  readonly combCells?: { readonly field: string; readonly cells: number };
  /** Filled by an incremental update: the source bytes are a prefix of the copy, its signatures kept. */
  readonly incremental?: boolean;
  /** Filled a second time as a flattened final copy: no field left in it. */
  readonly flatten?: boolean;
}

export interface FixtureExpectation {
  readonly group: string;
  readonly facts?: Readonly<Record<string, unknown>>;
  readonly refused?: string;
  readonly contained?: boolean;
  readonly contains?: readonly string[];
  readonly absent?: readonly string[];
  readonly hidden?: readonly string[];
  readonly fields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly absentFieldFlags?: Readonly<Record<string, readonly string[]>>;
  readonly fieldCount?: number;
  readonly fill?: FillExpectation;
  readonly refusals?: readonly { readonly field: string; readonly value: string | boolean; readonly refused: string }[];
  readonly find?: { readonly phrase: string; readonly pages: readonly number[] };
  readonly render?: { readonly page: number; readonly highlight?: readonly string[]; readonly alignment?: boolean };
  /** The share of `PRINTED_TEXT`'s words a scan's read gives back, at least (by the OCR add-on). */
  readonly ocrPresence?: number;
  /** The fixture is judged with the OCR add-on only: without it built, it is pending, whatever the tree. */
  readonly needsOcr?: boolean;
  /** A `format: "markdown"` read: phrases in this order, and text it holds. */
  readonly markdown?: { readonly order?: readonly string[]; readonly contains?: readonly string[] };
  /**
   * A flat form (`pdf.overlay`): its entry boxes' labels in order, values written over them and read back,
   * and boxes refused (a signature line).
   */
  readonly overlay?: {
    readonly boxes: readonly string[];
    readonly values: readonly { readonly field: string; readonly value: string }[];
    readonly refusals?: readonly { readonly field: string; readonly refused: string }[];
  };
  /** Opened with its user password: read as a password-encrypted document, filled on an answer sheet. */
  readonly password?: {
    readonly value: string;
    readonly contains?: readonly string[];
    readonly fill: { readonly field: string; readonly value: string };
  };
  readonly pending?: string;
  readonly note?: string;
}

export interface Manifest {
  readonly fixtures: Readonly<Record<string, FixtureExpectation>>;
}

export function readManifest(path = join(root, "evals", "pdf", "manifest.json")): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Whether `actual` has every key of `expected` with an equal value (deep, partial only at the top level of objects). */
export function matches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matches(item, actual[index]));
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => matches(value, (actual as Record<string, unknown>)[key]));
}

/** What one fixture showed, gathered by the runner. */
export interface Observation {
  readonly read?: PdfRunResult;
  /** The `markdown` expectation's read. */
  readonly markdown?: PdfRunResult;
  readonly fields?: PdfRunResult;
  readonly find?: PdfRunResult;
  readonly render?: PdfRunResult;
  readonly fill?: PdfRunResult;
  readonly fillOutputFacts?: PdfRunResult;
  /** Whether the source bytes are a byte-for-byte prefix of the filled copy. */
  readonly fillPrefix?: boolean;
  /** The flattened fill, and the facts of its copy. */
  readonly flatFill?: PdfRunResult;
  readonly flatFacts?: PdfRunResult;
  /** A flat form's fields answer, its overlay, and each overlay refusal. */
  readonly overlay?: {
    readonly fields: PdfRunResult;
    readonly written: PdfRunResult;
    readonly refusals: readonly { readonly field: string; readonly result: PdfRunResult }[];
  };
  /** The read and the fill with the fixture's password. */
  readonly withPassword?: { readonly read: PdfRunResult; readonly fill: PdfRunResult };
  readonly combCells?: number;
  readonly alignment?: boolean;
  readonly refusals?: readonly { readonly field: string; readonly result: PdfRunResult }[];
  readonly lagMs?: number;
}

/** The share of `expected`'s words (each counted once per time it occurs) that `got` holds, case aside. */
export function wordPresence(expected: string, got: string): number {
  const words = (text: string): string[] =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const left = new Map<string, number>();
  for (const word of words(got)) left.set(word, (left.get(word) ?? 0) + 1);
  const wanted = words(expected);
  let found = 0;
  for (const word of wanted) {
    const count = left.get(word) ?? 0;
    if (count > 0) {
      found += 1;
      left.set(word, count - 1);
    }
  }
  return wanted.length === 0 ? 1 : found / wanted.length;
}

/** The OCR add-on's files as the workspace builds them, as the add-on itself names them, when it is built. */
export async function ocrAddOn(): Promise<PdfOcrAssets | undefined> {
  const module = join(root, "packages", "pdf-ocr", "dist", "index.mjs");
  if (!existsSync(module)) return undefined;
  const assets = ((await import(pathToFileURL(module).href)) as { readonly ocrAssets: () => PdfOcrAssets }).ocrAssets();
  return existsSync(assets.languages.eng) ? assets : undefined;
}

const outcomeOf = (result: PdfRunResult | undefined): string =>
  result === undefined ? "not run" : result.ok ? "ok" : "refused" in result ? `refused ${result.refused}` : `failure ${result.failure}`;

/** Every way a fixture's observation departs from its expectation; empty when it passed. */
export function check(expectation: FixtureExpectation, observation: Observation): string[] {
  const problems: string[] = [];
  const read = observation.read;
  if (expectation.refused !== undefined) {
    if (read === undefined || read.ok || !("refused" in read) || read.refused !== expectation.refused)
      problems.push(`read: expected refused ${expectation.refused}, got ${outcomeOf(read)}`);
    if (expectation.password !== undefined) {
      const opened = observation.withPassword;
      if (opened === undefined || !opened.read.ok) problems.push(`password: read ${outcomeOf(opened?.read)}`);
      else {
        if (opened.read.answer.facts.encryption !== "password")
          problems.push(`password: encryption ${opened.read.answer.facts.encryption}`);
        const text = (opened.read.answer.pages ?? []).map((page) => page.text).join("\n");
        for (const phrase of expectation.password.contains ?? [])
          if (!text.includes(phrase)) problems.push(`password: missing "${phrase}"`);
      }
      if (opened === undefined || !opened.fill.ok || opened.fill.answer.fill?.answerSheet !== true)
        problems.push(`password: fill ${outcomeOf(opened?.fill)}, expected an answer sheet`);
    }
    return problems;
  }
  if (expectation.contained === true) {
    const fine = read !== undefined && (read.ok || "refused" in read || read.failure === "memory" || read.failure === "timeout");
    if (!fine) problems.push(`read: expected an answer, a refusal or a kill within caps, got ${outcomeOf(read)}`);
    if ((observation.lagMs ?? 0) > 1_000) problems.push(`the owner stalled ${observation.lagMs} ms`);
    if (read === undefined || !read.ok) return problems;
  }
  if (read === undefined || !read.ok) return [...problems, `read: ${outcomeOf(read)}`];
  const facts = read.answer.facts;
  if (expectation.markdown !== undefined) {
    const answer = observation.markdown;
    if (answer === undefined || !answer.ok) problems.push(`markdown: ${outcomeOf(answer)}`);
    else {
      const markdown = (answer.answer.pages ?? []).map((page) => page.text).join("\n\n");
      for (const phrase of expectation.markdown.contains ?? [])
        if (!markdown.includes(phrase)) problems.push(`markdown: missing "${phrase}"`);
      const at = (expectation.markdown.order ?? []).map((phrase) => markdown.indexOf(phrase));
      if (at.some((index) => index === -1) || at.some((index, position) => position > 0 && index <= (at[position - 1] ?? -1)))
        problems.push(`markdown: not in the order ${JSON.stringify(expectation.markdown.order)}`);
    }
  }
  if (expectation.ocrPresence !== undefined) {
    const presence = wordPresence(PRINTED_TEXT, (read.answer.pages ?? []).map((page) => page.text).join("\n"));
    if (presence < expectation.ocrPresence)
      problems.push(`ocr: ${(presence * 100).toFixed(1)}% of the printed words, expected ${expectation.ocrPresence * 100}%`);
  }
  if (expectation.facts !== undefined && !matches(expectation.facts, facts))
    problems.push(`facts: expected ${JSON.stringify(expectation.facts)}, got ${JSON.stringify({ ...facts, sha256: undefined })}`);
  const text = (read.answer.pages ?? []).map((page) => page.text).join("\n");
  const hidden = (read.answer.pages ?? []).flatMap((page) => page.hidden ?? []);
  for (const phrase of expectation.contains ?? []) if (!text.includes(phrase)) problems.push(`text: missing "${phrase}"`);
  for (const phrase of expectation.absent ?? []) if (text.includes(phrase)) problems.push(`text: holds "${phrase}"`);
  for (const reason of expectation.hidden ?? [])
    if (!hidden.some((span) => span.reason === reason)) problems.push(`hidden: no ${reason} span`);
  if (expectation.fields !== undefined || expectation.fieldCount !== undefined || expectation.absentFieldFlags !== undefined) {
    const answer = observation.fields;
    if (answer === undefined || !answer.ok) problems.push(`fields: ${outcomeOf(answer)}`);
    else {
      const fields = new Map((answer.answer.fields ?? []).map((field) => [field.id, field]));
      if (expectation.fieldCount !== undefined && fields.size !== expectation.fieldCount)
        problems.push(`fields: ${fields.size}, expected ${expectation.fieldCount}`);
      for (const [id, expected] of Object.entries(expectation.fields ?? {})) {
        const field = fields.get(id);
        if (field === undefined || !matches(expected, field))
          problems.push(`field ${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(field)}`);
      }
      for (const [id, flags] of Object.entries(expectation.absentFieldFlags ?? {})) {
        for (const flag of flags)
          if ((fields.get(id) as Record<string, unknown> | undefined)?.[flag] !== undefined) problems.push(`field ${id}: carries ${flag}`);
      }
    }
  }
  if (expectation.find !== undefined) {
    const pages =
      observation.find !== undefined && observation.find.ok ? (observation.find.answer.pages ?? []).map((page) => page.page) : undefined;
    if (!matches(expectation.find.pages, pages))
      problems.push(`find: pages ${JSON.stringify(pages)}, expected ${JSON.stringify(expectation.find.pages)}`);
  }
  if (expectation.render !== undefined) {
    const render = observation.render;
    if (render === undefined || !(render.ok || ("failure" in render && (render.failure === "memory" || render.failure === "timeout"))))
      problems.push(`render: ${outcomeOf(render)}`);
    if (expectation.render.alignment === true && observation.alignment !== true)
      problems.push("render: the outline does not frame the widget");
  }
  if (expectation.fill !== undefined) {
    const fill = observation.fill;
    const want = expectation.fill.expect;
    if (want === "ok" || want === "answerSheet") {
      if (fill === undefined || !fill.ok) problems.push(`fill: ${outcomeOf(fill)}`);
      else {
        const answer = fill.answer.fill;
        if ((want === "answerSheet") !== (answer?.answerSheet === true))
          problems.push(`fill: answer sheet ${String(answer?.answerSheet)}, expected ${String(want === "answerSheet")}`);
        if (want === "ok" && answer?.readBack.some((row) => !row.ok) !== false)
          problems.push(`fill: read back ${JSON.stringify(answer?.readBack)}`);
        if (
          expectation.fill.leftUserOnly !== undefined &&
          !matches([...expectation.fill.leftUserOnly].sort(), [...(answer?.leftUserOnly ?? [])].sort())
        )
          problems.push(`fill: left ${JSON.stringify(answer?.leftUserOnly)}`);
        if (expectation.fill.outputActiveContent !== undefined) {
          const output = observation.fillOutputFacts;
          const kinds = output !== undefined && output.ok ? output.answer.facts.activeContent.filter((kind) => kind !== "uri") : undefined;
          if (!matches(expectation.fill.outputActiveContent, kinds)) problems.push(`fill: output active content ${JSON.stringify(kinds)}`);
        }
        if (expectation.fill.flatten === true) {
          const flat = observation.flatFill;
          const facts = observation.flatFacts;
          const fieldCount = facts !== undefined && facts.ok ? facts.answer.facts.fieldCount : undefined;
          if (flat === undefined || !flat.ok || flat.answer.fill?.flattened !== true || fieldCount !== 0)
            problems.push(`fill: flattened ${flat === undefined ? "not run" : outcomeOf(flat)}, fields left ${String(fieldCount)}`);
        }
        if (expectation.fill.incremental === true) {
          const output = observation.fillOutputFacts;
          const signatures = output !== undefined && output.ok ? output.answer.facts.signatures : undefined;
          if (answer?.incremental !== true || observation.fillPrefix !== true)
            problems.push(`fill: incremental ${String(answer?.incremental)}, prefix ${String(observation.fillPrefix)}`);
          if (signatures !== expectation.facts?.["signatures"]) problems.push(`fill: output signatures ${String(signatures)}`);
        }
        if (expectation.fill.combCells !== undefined && (observation.combCells ?? 0) < expectation.fill.combCells.cells)
          problems.push(`fill: comb glyphs in ${observation.combCells ?? 0} cells, expected ${expectation.fill.combCells.cells}`);
      }
    } else if (fill === undefined || fill.ok || !("refused" in fill) || fill.refused !== want.refused)
      problems.push(`fill: expected refused ${want.refused}, got ${outcomeOf(fill)}`);
  }
  if (expectation.overlay !== undefined) {
    const seen = observation.overlay;
    const labels = seen !== undefined && seen.fields.ok ? (seen.fields.answer.boxes ?? []).map((box) => box.label ?? "") : undefined;
    if (!matches(expectation.overlay.boxes, labels)) problems.push(`overlay: boxes ${JSON.stringify(labels)}`);
    const written = seen?.written;
    if (
      written === undefined ||
      !written.ok ||
      written.answer.fill?.readBack.some((row) => !row.ok) !== false ||
      written.answer.fill.readBack.length !== expectation.overlay.values.length
    )
      problems.push(`overlay: ${outcomeOf(written)}`);
    for (const refusal of expectation.overlay.refusals ?? []) {
      const result = seen?.refusals.find((entry) => entry.field === refusal.field)?.result;
      if (result === undefined || result.ok || !("refused" in result) || result.refused !== refusal.refused)
        problems.push(`overlay ${refusal.field}: expected refused ${refusal.refused}, got ${outcomeOf(result)}`);
    }
  }
  for (const refusal of expectation.refusals ?? []) {
    const result = observation.refusals?.find((entry) => entry.field === refusal.field)?.result;
    if (result === undefined || result.ok || !("refused" in result) || result.refused !== refusal.refused)
      problems.push(`fill ${refusal.field}: expected refused ${refusal.refused}, got ${outcomeOf(result)}`);
  }
  return problems;
}

// ------------------------------------------------------------------ the runner's helpers

/** An RGBA PNG of `encodePng`'s shape (filter 0 on every row) back to pixels. */
export function decodePng(png: Uint8Array): { readonly width: number; readonly height: number; readonly pixels: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset).getUint32(4);
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1)
    pixels.set(raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), row * width * 4);
  return { width, height, pixels };
}

/**
 * Whether the yellow outline frames `rect` on a `/Rotate 90` page cropped to
 * `crop`, computed here independently of the engine's mapping: rotated a
 * quarter turn clockwise, page `y` runs along device `x` and page `x` down
 * device `y`.
 */
export function framesRotated(
  image: { readonly width: number; readonly height: number; readonly pixels: Uint8Array },
  rect: readonly [number, number, number, number],
  crop: readonly [number, number, number, number],
  scale: number,
): boolean {
  const yellow = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const at = (y * image.width + x) * 4;
    return image.pixels[at] === 255 && image.pixels[at + 1] === 200 && image.pixels[at + 2] === 0;
  };
  const left = Math.round((rect[1] - crop[1]) * scale);
  const right = Math.round((rect[3] - crop[1]) * scale);
  const top = Math.round((rect[0] - crop[0]) * scale);
  const bottom = Math.round((rect[2] - crop[0]) * scale);
  const near = (x: number, y: number): boolean =>
    [-3, -2, -1, 0, 1, 2, 3].some((dx) => [-3, -2, -1, 0, 1, 2, 3].some((dy) => yellow(x + dx, y + dy)));
  return (
    near(left, Math.round((top + bottom) / 2)) &&
    near(right, Math.round((top + bottom) / 2)) &&
    near(Math.round((left + right) / 2), top) &&
    near(Math.round((left + right) / 2), bottom)
  );
}

/** How many distinct glyph positions a field's appearance stream draws: one per comb cell when combed. */
async function combPositions(bytes: Uint8Array, field: string): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const widget = document.getForm().getTextField(field).acroField.getWidgets()[0];
  const normal = widget?.dict.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
  if (!(normal instanceof PDFRawStream)) return 0;
  const content = new TextDecoder("latin1").decode(decodePDFRawStream(normal).decode());
  // pdf-lib places each comb cell's glyph with its own text matrix.
  return new Set([...content.matchAll(/1 0 0 1 (-?[\d.]+) -?[\d.]+ Tm/g)].map((match) => match[1])).size;
}

/** The longest the owner's event loop was held while `work` ran. */
async function withLag<T>(work: () => Promise<T>): Promise<{ readonly result: T; readonly lagMs: number }> {
  let lag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    lag = Math.max(lag, now - last - 50);
    last = now;
  }, 50);
  try {
    return { result: await work(), lagMs: lag };
  } finally {
    clearInterval(timer);
  }
}

async function observe(service: PdfService, expectation: FixtureExpectation, bytes: Uint8Array): Promise<Observation> {
  // As `pdf.read` reads: with OCR where the service has the add-on.
  const { result: read, lagMs } = await withLag(async () => {
    const withOcr = await service.readWithOcr(bytes, {});
    return withOcr.read.ok ? { ...withOcr.read, answer: { ...withOcr.read.answer, pages: [...withOcr.pages] } } : withOcr.read;
  });
  const withPassword =
    expectation.password === undefined
      ? undefined
      : {
          read: await service.run({ op: "read", password: expectation.password.value }, bytes),
          fill: await service.run(
            { op: "fill", password: expectation.password.value, plan: { values: [expectation.password.fill], preview: false } },
            bytes,
            fillFonts(),
          ),
        };
  if (!read.ok) return { read, lagMs, ...(withPassword === undefined ? {} : { withPassword }) };
  const markdown = expectation.markdown === undefined ? undefined : await service.run({ op: "read", format: "markdown" }, bytes);
  const fields =
    expectation.fields !== undefined || expectation.fieldCount !== undefined || expectation.absentFieldFlags !== undefined
      ? await service.run({ op: "fields" }, bytes)
      : undefined;
  const find = expectation.find === undefined ? undefined : await service.run({ op: "read", find: expectation.find.phrase }, bytes);
  let render: PdfRunResult | undefined;
  let alignment: boolean | undefined;
  if (expectation.render !== undefined) {
    render = await service.run(
      {
        op: "render",
        pages: [expectation.render.page],
        dpi: 72,
        highlight: [...(expectation.render.highlight ?? [])],
        outlineUserOnly: false,
      },
      bytes,
    );
    if (expectation.render.alignment === true && render.ok) {
      const field = (await service.run({ op: "fields" }, bytes)) as PdfRunResult;
      const rect = field.ok
        ? field.answer.fields?.find((candidate) => candidate.id === expectation.render?.highlight?.[0])?.rect
        : undefined;
      const png = render.pngs[0];
      alignment = rect !== undefined && png !== undefined && framesRotated(decodePng(png.png), rect, [50, 50, 500, 700], 1);
    }
  }
  let fill: PdfRunResult | undefined;
  let fillOutputFacts: PdfRunResult | undefined;
  let combCells: number | undefined;
  let fillPrefix: boolean | undefined;
  let flatFill: PdfRunResult | undefined;
  let flatFacts: PdfRunResult | undefined;
  if (expectation.fill !== undefined) {
    const values = expectation.fill.values.map((row) => ({
      field: row.field,
      value: typeof row.value === "string" || typeof row.value === "boolean" ? row.value : [...row.value],
    }));
    fill = await service.run({ op: "fill", plan: { values, preview: true } }, bytes, fillFonts());
    if (expectation.fill.flatten === true) {
      flatFill = await service.run({ op: "fill", plan: { values, preview: true, flatten: true } }, bytes, fillFonts());
      if (flatFill.ok) flatFacts = await service.run({ op: "facts" }, flatFill.document);
    }
    if (fill.ok && (expectation.fill.outputActiveContent !== undefined || expectation.fill.incremental === true))
      fillOutputFacts = await service.run({ op: "facts" }, fill.document);
    if (fill.ok && expectation.fill.incremental === true)
      fillPrefix = fill.document.length > bytes.length && Buffer.from(fill.document.subarray(0, bytes.length)).equals(Buffer.from(bytes));
    if (fill.ok && expectation.fill.combCells !== undefined)
      combCells = await combPositions(fill.document, expectation.fill.combCells.field);
  }
  const overlay =
    expectation.overlay === undefined
      ? undefined
      : {
          fields: await service.run({ op: "fields" }, bytes),
          written: await service.run(
            { op: "overlay", plan: { values: expectation.overlay.values.map((row) => ({ ...row })), preview: true } },
            bytes,
            fillFonts(),
          ),
          refusals: await Promise.all(
            (expectation.overlay.refusals ?? []).map(async (refusal) => ({
              field: refusal.field,
              result: await service.run(
                { op: "overlay", plan: { values: [{ field: refusal.field, value: "Leo" }], preview: false } },
                bytes,
                fillFonts(),
              ),
            })),
          ),
        };
  const refusals = [];
  for (const refusal of expectation.refusals ?? []) {
    refusals.push({
      field: refusal.field,
      result: await service.run(
        { op: "fill", plan: { values: [{ field: refusal.field, value: refusal.value }], preview: false } },
        bytes,
        fillFonts(),
      ),
    });
  }
  return {
    read,
    lagMs,
    ...(markdown === undefined ? {} : { markdown }),
    ...(fields === undefined ? {} : { fields }),
    ...(find === undefined ? {} : { find }),
    ...(render === undefined ? {} : { render }),
    ...(alignment === undefined ? {} : { alignment }),
    ...(fill === undefined ? {} : { fill }),
    ...(fillOutputFacts === undefined ? {} : { fillOutputFacts }),
    ...(combCells === undefined ? {} : { combCells }),
    ...(fillPrefix === undefined ? {} : { fillPrefix }),
    ...(overlay === undefined ? {} : { overlay }),
    ...(flatFill === undefined ? {} : { flatFill }),
    ...(flatFacts === undefined ? {} : { flatFacts }),
    refusals,
  };
}

export interface FixtureReport {
  readonly name: string;
  readonly group: string;
  readonly status: "pass" | "fail" | "pending";
  readonly problems: readonly string[];
  readonly outcome: string;
  readonly peakKb?: number;
  readonly wallMs?: number;
  readonly bytes: number;
  readonly lagMs?: number;
}

/** Run `names` (all by default) and report each. */
export async function runEval(
  options: { readonly names?: readonly string[]; readonly service?: PdfService } = {},
): Promise<FixtureReport[]> {
  const manifest = readManifest();
  const ocr = await ocrAddOn();
  const service = options.service ?? createPdfService({ sandbox: { kind: "none" }, warm: true, ...(ocr === undefined ? {} : { ocr }) });
  const reports: FixtureReport[] = [];
  try {
    for (const name of options.names ?? Object.keys(manifest.fixtures)) {
      const expectation = manifest.fixtures[name];
      if (expectation === undefined) throw new Error(`${name} is not in the manifest`);
      const bytes = await buildFixture(name);
      const observation = await observe(service, expectation, bytes);
      const problems = check(expectation, observation);
      const read = observation.read;
      reports.push({
        name,
        group: expectation.group,
        status:
          expectation.needsOcr === true && !service.ocrAvailable
            ? "pending"
            : problems.length === 0
              ? "pass"
              : expectation.pending === undefined
                ? "fail"
                : "pending",
        problems,
        outcome: outcomeOf(read),
        ...(read?.ok === true ? { peakKb: read.peakKb, wallMs: read.wallMs } : {}),
        bytes: bytes.length,
        ...(observation.lagMs === undefined ? {} : { lagMs: observation.lagMs }),
      });
    }
  } finally {
    if (options.service === undefined) await service.close();
  }
  return reports;
}

/** Cold and warm start, and native search across the 200-page manual. */
async function timings(): Promise<Record<string, number>> {
  const tiny = await buildFixture("zero-page");
  const cold = createPdfService({ sandbox: { kind: "none" }, warm: false });
  let started = Date.now();
  await cold.run({ op: "facts" }, tiny);
  const coldMs = Date.now() - started;
  await cold.close();
  const warm = createPdfService({ sandbox: { kind: "none" }, warm: true });
  warm.prewarm();
  await new Promise((done) => setTimeout(done, 1_000));
  started = Date.now();
  await warm.run({ op: "facts" }, tiny);
  const warmMs = Date.now() - started;
  const manual = await buildFixture("manual");
  started = Date.now();
  const find = await warm.run({ op: "read", find: "drain pump filter" }, manual);
  const findMs = Date.now() - started;
  await warm.close();
  return { coldMs, warmMs, findManualMs: findMs, findManualPeakKb: find.ok ? find.peakKb : -1 };
}

/**
 * What the PDF package installs, against its budget: its third-party
 * dependencies (none: the libraries are bundled into `dist/child.mjs`), its
 * built files and its font, from the workspace's build.
 */
function footprint(): Record<string, number> {
  const kb = (path: string): number => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s+/)[0]);
  const directory = join(root, "packages", "builtin", "pdf");
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  return {
    installedThirdPartyDependencies: Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith("@tavi/")).length,
    distKb: kb(join(directory, "dist")),
    assetsKb: kb(join(directory, "assets")),
  };
}

/**
 * The framing at its caps: three 4-megapixel pages in one
 * answer, and a filled document of 25 MiB, through the child without base64.
 */
async function framing(): Promise<Record<string, number | string>> {
  const service = createPdfService({ sandbox: { kind: "none" }, warm: false });
  try {
    const big = await PDFDocument.create({ updateMetadata: false });
    for (let index = 0; index < 3; index += 1)
      big.addPage([2_000, 2_000]).drawRectangle({ x: 100, y: 100, width: 1_800, height: 1_800, borderWidth: 4 });
    const render = await service.run({ op: "render", pages: [1, 2, 3], dpi: 200, highlight: [], outlineUserOnly: false }, await big.save());
    const filled = await PDFDocument.create({ updateMetadata: false });
    const page = filled.addPage([600, 800]);
    filled.getForm().createTextField("name").addToPage(page, { x: 100, y: 700, width: 200, height: 20 });
    // 25 MiB less room for the rest, in a stream nothing decodes: incompressible bytes.
    const noise = new Uint8Array(25 * 1024 * 1024 - 64 * 1024);
    for (let at = 0, state = 1; at < noise.length; at += 1) {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      noise[at] = state >>> 24;
    }
    filled.catalog.set(PDFName.of("TaviPadding"), filled.context.register(filled.context.stream(noise)));
    const input = await filled.save();
    const fill = await service.run({ op: "fill", plan: { values: [{ field: "name", value: "Leo" }], preview: false } }, input, fillFonts());
    return {
      renderOutcome: outcomeOf(render),
      renderPngBytes: render.ok ? render.pngs.reduce((sum, frame) => sum + frame.png.length, 0) : -1,
      renderPixels: render.ok ? (render.answer.rendered ?? []).map((frame) => frame.width * frame.height).join(",") : "",
      fillInputBytes: input.length,
      fillOutcome: outcomeOf(fill),
      fillOutputBytes: fill.ok ? fill.document.length : -1,
      fillPeakKb: fill.ok ? fill.peakKb : -1,
    };
  } finally {
    await service.close();
  }
}

/** The most threads the child ran while reading the 200-page manual (`pids.max` counts threads). */
async function threads(): Promise<number> {
  let most = 0;
  let pid: number | undefined;
  const service = createPdfService({
    sandbox: { kind: "none" },
    warm: false,
    observe: (event) => {
      if (event.kind === "spawn") pid = event.pid;
    },
  });
  const count = (): number => {
    if (pid === undefined) return 0;
    try {
      return process.platform === "linux"
        ? Number(execFileSync("sh", ["-c", `ls /proc/${pid}/task | wc -l`], { encoding: "utf8" }))
        : execFileSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" })
            .trim()
            .split("\n").length - 1;
    } catch {
      return 0;
    }
  };
  const timer = setInterval(() => {
    most = Math.max(most, count());
  }, 20);
  try {
    await service.run({ op: "read", find: "drain pump filter" }, await buildFixture("manual"));
  } finally {
    clearInterval(timer);
    await service.close();
  }
  return most;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at >= 0 ? process.argv[at + 1] : undefined;
  };
  const names = argument("--fixture")?.split(",");
  const label = argument("--label") ?? new Date().toISOString().slice(0, 10);
  const out = resolve(argument("--out") ?? join(root, "evals", "pdf", "results"));
  const reports = await runEval(names === undefined ? {} : { names });
  const summary = {
    label,
    fixtures: reports.length,
    passed: reports.filter((report) => report.status === "pass").length,
    pending: reports.filter((report) => report.status === "pending").map((report) => report.name),
    failed: reports.filter((report) => report.status === "fail").map((report) => report.name),
    timings: await timings(),
    footprint: footprint(),
    framing: await framing(),
    childThreads: await threads(),
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    fixtureCount: Object.keys(FIXTURES).length,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.json`), `${JSON.stringify({ summary, reports }, null, 2)}\n`);
  for (const report of reports)
    process.stdout.write(
      `${report.status.padEnd(8)} ${report.name.padEnd(30)} ${report.outcome.padEnd(24)} ${String(report.peakKb ?? "").padStart(7)} KiB ${String(report.wallMs ?? "").padStart(5)} ms${report.problems.length === 0 ? "" : `  ${report.problems.join("; ")}`}\n`,
    );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.failed.length === 0 ? 0 : 1);
}
