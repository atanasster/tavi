import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

/**
 * The writer's decompression cap: a local
 * patch of `@cantoo/pdf-lib`, pinned to the version it was written for.
 */
const require = createRequire(import.meta.url);
const repository = join(import.meta.dirname, "..");

function flateStream(document: PDFDocument, decodedBytes: number): PDFRawStream {
  const contents = deflateSync(Buffer.alloc(decodedBytes));
  const dict = document.context.obj({ Filter: PDFName.of("FlateDecode"), Length: PDFNumber.of(contents.length) });
  return PDFRawStream.of(dict, contents);
}

describe("the @cantoo/pdf-lib decompression cap", () => {
  it("is pinned: the installed version is the patched one, and the workspace applies the patch", () => {
    // Bundled into the parser child, so a development dependency (package.json `taviBundled`).
    const manifest = JSON.parse(readFileSync(join(repository, "packages", "builtin", "pdf", "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    // The version is the workspace catalog's, and the one installed is that version.
    expect(manifest.devDependencies["@cantoo/pdf-lib"]).toBe("catalog:");
    const packageRoot = require.resolve("@cantoo/pdf-lib").replace(/cjs[/\\]index\.js$/, "");
    const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
    expect(version).toBe("2.11.1");
    const workspace = readFileSync(join(repository, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain(`"@cantoo/pdf-lib": ${version}`);
    expect(workspace).toContain(`'@cantoo/pdf-lib@${version}': patches/@cantoo__pdf-lib@${version}.patch`);
    for (const build of ["es", "cjs"]) {
      const source = readFileSync(
        join(require.resolve("@cantoo/pdf-lib").replace(/cjs[/\\]index\.js$/, ""), build, "core", "streams", "DecodeStream.js"),
        "utf8",
      );
      expect(source, `${build} build`).toContain("MAX_DECODED_STREAM_BYTES = 100 * 1024 * 1024");
      expect(source, `${build} build`).toContain("size = Math.min(size, MAX_DECODED_STREAM_BYTES);");
    }
  });

  it("decodes a stream under the cap", async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    expect(decodePDFRawStream(flateStream(document, 1024 * 1024)).decode().length).toBe(1024 * 1024);
  });

  it("refuses a stream that inflates past 100 MiB", async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    expect(() => decodePDFRawStream(flateStream(document, 101 * 1024 * 1024)).decode()).toThrow(/Decoded stream exceeds/);
  });

  it("refuses an object stream that inflates past the cap while loading", async () => {
    // A valid object stream: unpatched, it decodes and registers object 4.
    const decoded = Buffer.alloc(150 * 1024 * 1024, 0x20);
    decoded.write("4 0 null", 0);
    const body = deflateSync(decoded);
    const head = Buffer.from(
      `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n3 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${body.length} >>\nstream\n`,
    );
    const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 5 >>\n%%EOF\n");
    const document = await PDFDocument.load(Buffer.concat([head, body, tail]), { updateMetadata: false });
    expect(document.getPageCount()).toBe(0);
    expect(document.context.lookup(PDFRef.of(4, 0))).toBeUndefined();
  });
});
