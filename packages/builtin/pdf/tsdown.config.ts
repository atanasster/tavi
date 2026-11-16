import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/host.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
  },
  {
    // The child is spawned, never imported, and bundles everything it runs: under srt it may read its own
    // package directory and Node, not the dependency store; and what it
    // bundles is not installed with Tavi (package.json `taviBundled`, scripts/third-party-notices.mjs at the repository root).
    // The OCR child bundles the same way; Tesseract itself it loads from the add-on's directory at run time.
    entry: ["src/child.ts", "src/ocr-child.ts"],
    // PDFium's wasm ships beside the child: the owner reads it from here and sends it.
    copy: [{ from: "node_modules/@embedpdf/pdfium/dist/pdfium.wasm", to: "dist" }],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
    sourcemap: false,
    target: "node22",
    deps: { alwaysBundle: [/.*/] },
  },
]);
