import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PdfChildLimits } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { buildFixture } from "../../evals/pdf/build-fixtures.js";
import { PdfEngine } from "../../packages/builtin/pdf/src/engine.js";
import { testPdfium } from "../../packages/builtin/pdf/test/support.js";

/**
 * `flatten: true` on the PDF eval's signed form: the engine with a fixture the repository's eval builds, so
 * the engine's own tests reach nothing outside its package.
 */

const pdfPackage = join(import.meta.dirname, "..", "..", "packages", "builtin", "pdf");
const limits: PdfChildLimits = { maxPages: 500, maxFields: 1_000, maxPixelsPerPage: 4_000_000, textPerCall: 40_000, pagesPerTextCall: 40 };
const font = new Uint8Array(readFileSync(join(pdfPackage, "assets", "NotoSans-Regular.ttf")));

describe("flattening a signed form", () => {
  it("is refused", async () => {
    // The eval's own signed form, built as the eval builds it: the built files are not kept in the tree.
    const signed = new Uint8Array(await buildFixture("signed"));
    const opened = await new PdfEngine(await testPdfium()).open(signed, limits);
    if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
    try {
      expect(await opened.fill({ values: [{ field: "name", value: "Leo" }], preview: false, flatten: true }, [font])).toMatchObject({
        refused: "flatten-not-permitted",
      });
    } finally {
      opened.close();
    }
  });
});
