import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPdfService, type PdfService } from "../../packages/builtin/pdf/src/host.js";
import { sampleForm } from "../../packages/builtin/pdf/test/support.js";
import { srtWrapper } from "./support/srt.js";

/**
 * The PDF engine's child under the sandbox's srt wrapper, as the owner composes the two: the engine takes a
 * wrapper in its options and never imports the sandbox, so they meet here.
 */
const pdfPackage = join(import.meta.dirname, "..", "..", "packages", "builtin", "pdf");
const childPath = join(pdfPackage, "dist", "child.mjs");
const services: PdfService[] = [];
const service = (options: Partial<Parameters<typeof createPdfService>[0]> = {}): PdfService => {
  const created = createPdfService({ sandbox: { kind: "none" }, childPath, warm: false, ...options });
  services.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(services.splice(0).map((created) => created.close()));
});

describe("the PDF service under srt", () => {
  it.skipIf(process.platform !== "darwin")("runs under srt with no network and no writable path", async () => {
    const wrap = srtWrapper(join(pdfPackage, "node_modules", ".srt-test", "pdf-srt.json"));
    const pdf = service({ sandbox: { kind: "wrapped", wrap } });
    const fields = await pdf.run({ op: "fields" }, await sampleForm());
    expect(fields.ok).toBe(true);
  });
});
