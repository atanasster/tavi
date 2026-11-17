import { existsSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPdfService, defaultChildPath, fillFonts, type PdfService } from "../src/host.js";
import { sampleForm } from "./support.js";

/** The built child (turbo builds this package before its tests). */
const childPath = join(import.meta.dirname, "..", "dist", "child.mjs");
const services: PdfService[] = [];
const service = (options: Partial<Parameters<typeof createPdfService>[0]> = {}): PdfService => {
  const created = createPdfService({ sandbox: { kind: "none" }, childPath, warm: false, ...options });
  services.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(services.splice(0).map((created) => created.close()));
});

describe("the PDF service", () => {
  it("runs the built child", () => {
    expect(existsSync(childPath), "build @tavi/plugin-pdf before its tests").toBe(true);
    expect(defaultChildPath().endsWith("child.mjs")).toBe(true);
  });

  it("answers facts, text, fields and renders through one child per document", async () => {
    const pdf = service();
    const bytes = await sampleForm();
    const read = await pdf.run({ op: "read", find: "drain pump" }, bytes);
    expect(read.ok && read.answer.pages?.[0]?.page).toBe(1);
    const fields = await pdf.run({ op: "fields" }, bytes);
    expect(fields.ok && fields.answer.fields?.map((field) => field.id)).toEqual(["child.name", "agree", "gender", "state"]);
    const render = await pdf.run({ op: "render", pages: [1], dpi: 72, highlight: ["child.name"], outlineUserOnly: false }, bytes);
    expect(render.ok && render.pngs.map((frame) => frame.page)).toEqual([1]);
    expect(render.ok && render.answer.maxRssKb).toBeGreaterThan(0);
  });

  it("brings the filled document back as bytes", async () => {
    const pdf = service();
    const filled = await pdf.run(
      { op: "fill", plan: { values: [{ field: "child.name", value: "Лео" }], preview: true } },
      await sampleForm(),
      fillFonts(),
    );
    if (!filled.ok) throw new Error(JSON.stringify(filled));
    expect(filled.answer.fill?.readBack).toEqual([{ field: "child.name", ok: true }]);
    expect(new TextDecoder().decode(filled.document.subarray(0, 5))).toBe("%PDF-");
    expect(filled.pngs).toHaveLength(1);
  });

  it("fails a call the owner cannot frame without refusing its document for a day", async () => {
    const pdf = service();
    const bytes = await sampleForm();
    // Five fonts: past the frame's four, the owner's own limit.
    const fonts = fillFonts([
      fillFonts()[0] as Uint8Array,
      fillFonts()[0] as Uint8Array,
      fillFonts()[0] as Uint8Array,
      fillFonts()[0] as Uint8Array,
    ]);
    expect(await pdf.run({ op: "fill", plan: { values: [{ field: "child.name", value: "Leo" }], preview: false } }, bytes, fonts)).toEqual({
      ok: false,
      failure: "protocol",
    });
    expect((await pdf.run({ op: "facts" }, bytes)).ok).toBe(true);
  });

  it("passes the child's refusals on", async () => {
    expect(await service().run({ op: "facts" }, new TextEncoder().encode("not a pdf at all"))).toEqual({ ok: false, refused: "not-a-pdf" });
  });

  it("refuses an input over the size limit without a child", async () => {
    expect(await service({ limits: { maxInputBytes: 10 } }).run({ op: "facts" }, await sampleForm())).toEqual({
      ok: false,
      refused: "too-large",
    });
  });

  it("answers a launch its confinement refuses as refused, before any child, without refusing the document later", async () => {
    let allowed = false;
    let spawns = 0;
    const pdf = service({
      warm: true,
      // As the owner's wrap does while the sandbox is unavailable and serve has no --pdf-allow-unconfined.
      sandbox: {
        kind: "wrapped",
        wrap: (launch) =>
          allowed ? { command: launch.argv[0] as string, args: launch.argv.slice(1), env: launch.env } : { refused: "unconfined" },
      },
      ocr: {
        directory: "/nonexistent/ocr",
        core: "/nonexistent/ocr/core.js",
        wasm: "/nonexistent/ocr/core.wasm",
        languages: { eng: "/nonexistent/ocr/eng.gz" },
      },
      observe: (event) => (spawns += event.kind === "spawn" ? 1 : 0),
    });
    const bytes = await sampleForm();
    pdf.prewarm();
    expect(await pdf.run({ op: "facts" }, bytes)).toEqual({ ok: false, refused: "unconfined" });
    expect(await pdf.ocr([{ page: 1, png: new Uint8Array([1]) }])).toEqual({ ok: false, refused: "unconfined" });
    expect(spawns).toBe(0);
    // Allowed (or the sandbox fixed): the same document reads at once, never banned for a day.
    allowed = true;
    expect((await pdf.run({ op: "facts" }, bytes)).ok).toBe(true);
    expect(spawns).toBeGreaterThan(0);
  });

  it("kills a child over its memory cap, and refuses the same document again", async () => {
    const pdf = service({ limits: { childRssMb: 1 } });
    // Long enough to outlast the watchdog's first sample.
    const document = await PDFDocument.create({ updateMetadata: false });
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 400; index += 1)
      document.addPage().drawText(`page ${index} ${"words ".repeat(40)}`, { x: 20, y: 700, size: 8, font });
    const bytes = await document.save();
    expect(await pdf.run({ op: "read", find: "not on any page" }, bytes)).toEqual({ ok: false, failure: "memory" });
    // Refused at once, with the same reason, and no child.
    expect(await pdf.run({ op: "read", find: "not on any page" }, bytes)).toEqual({ ok: false, failure: "memory" });
  });

  it("kills a child past its wall clock, and refuses the document for a day", async () => {
    let clock = 0;
    let spawns = 0;
    const pdf = service({ limits: { timeoutMs: 1 }, now: () => clock, observe: (event) => (spawns += event.kind === "spawn" ? 1 : 0) });
    const bytes = await sampleForm();
    expect(await pdf.run({ op: "facts" }, bytes)).toEqual({ ok: false, failure: "timeout" });
    const spawned = spawns;
    expect(await pdf.run({ op: "facts" }, bytes)).toEqual({ ok: false, failure: "timeout" });
    expect(spawns).toBe(spawned);
    clock += 24 * 60 * 60_000 + 1;
    const later = await pdf.run({ op: "facts" }, bytes);
    expect(later).toEqual({ ok: false, failure: "timeout" });
  });

  it("hands a warm child the next document, and warms another after it", async () => {
    const spawned: (number | undefined)[] = [];
    const exited: (number | undefined)[] = [];
    const pdf = service({ warm: true, observe: (event) => (event.kind === "spawn" ? spawned : exited).push(event.pid) });
    pdf.prewarm();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const answer = await pdf.run({ op: "facts" }, await sampleForm());
    expect(answer.ok).toBe(true);
    // The call used the warm child, which ends with its document; the one spawned after it
    // is the next warm one and is still waiting. (Not a stopwatch: a busy runner is slow either way.)
    expect(spawned).toHaveLength(2);
    await vi.waitFor(() => expect(exited).toEqual([spawned[0]]));
  });

  it("queues calls past its concurrency", async () => {
    let running = 0;
    let most = 0;
    const pdf = service({
      concurrency: 1,
      observe: (event) => {
        running += event.kind === "spawn" ? 1 : -1;
        most = Math.max(most, running);
      },
    });
    const document = await PDFDocument.create({ updateMetadata: false });
    document.addPage();
    const bytes = await document.save();
    const answers = await Promise.all([1, 2, 3].map(() => pdf.run({ op: "facts" }, bytes)));
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(most).toBe(1);
  });

  it("stops queued calls when it closes", async () => {
    const pdf = service({ concurrency: 1 });
    const bytes = await sampleForm();
    const calls = [pdf.run({ op: "facts" }, bytes), pdf.run({ op: "fields" }, bytes)];
    await pdf.close();
    const [, queued] = await Promise.all(calls);
    expect(queued).toEqual({ ok: false, failure: "crashed" });
  });

  it("reports a child that dies without answering as crashed, and refuses its document", async () => {
    const pdf = service({ childPath: join(import.meta.dirname, "fixtures", "crash-child.mjs") });
    const bytes = await sampleForm();
    expect(await pdf.run({ op: "facts" }, bytes)).toEqual({ ok: false, failure: "crashed" });
    expect(await pdf.run({ op: "facts" }, bytes)).toEqual({ ok: false, failure: "crashed" });
  });
});
