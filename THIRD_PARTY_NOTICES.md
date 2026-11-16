# Third-party notices

Tavi is MIT-licensed ([LICENSE](LICENSE)). It includes, adapts or ships the
third-party material below under the licences named. Packages installed from
npm carry their own licence files in `node_modules`; `tests/licences.test.ts`
holds every installed and bundled dependency to a permissive licence.

## Code adapted into Tavi

- **LangChain LangGraph SQLite checkpoint saver** — MIT, © 2024 LangChain.
  `packages/runtime/src/persistence/checkpoints.ts` is adapted from it; the
  licence text is in
  [`packages/runtime/src/persistence/CHECKPOINT-LICENSE.txt`](packages/runtime/src/persistence/CHECKPOINT-LICENSE.txt).
- **pdfme** — MIT. The decompression cap in
  [`patches/@cantoo__pdf-lib@2.11.1.patch`](patches/@cantoo__pdf-lib@2.11.1.patch)
  is ported from pdfme. The patch applies to `@cantoo/pdf-lib` 2.11.1 (MIT)
  and closes advisory GHSA-vrqm-gvq7-rrwh until upstream ships a fix.

## Bundled into what Tavi builds

- **PDF parser child** (`packages/builtin/pdf`): the packages it bundles are
  listed in its `taviBundled`; the build writes their licences to
  `dist/THIRD-PARTY-NOTICES.txt` beside the bundle
  ([`scripts/third-party-notices.mjs`](scripts/third-party-notices.mjs)).
- **OCR add-on** (`packages/pdf-ocr`): Tesseract and the libraries compiled
  into its WebAssembly (Leptonica, libjpeg, libpng, libtiff, libwebp, giflib,
  zlib, musl, openlibm, LLVM compiler-rt, libc++, libc++abi, Emscripten); each
  licence is in [`packages/pdf-ocr/licenses/`](packages/pdf-ocr/licenses/) and
  the build writes them to `dist/THIRD-PARTY-NOTICES.txt`.
- **Web canvas** (`apps/ui`, served by `tavi ui`): React, react-markdown and
  the remark/rehype plugins, highlight.js, KaTeX and its fonts, Radix UI and
  the Inter typeface, among others: the packages listed in `apps/ui`'s
  `taviBundled` and everything they reach. The build writes each one's licence
  to `dist/THIRD-PARTY-NOTICES.txt`, which ships with the canvas.

## Fonts and data shipped as assets

- **Noto Sans** — SIL Open Font License 1.1, used to fill PDF forms:
  [`packages/builtin/pdf/assets/NotoSans-OFL.txt`](packages/builtin/pdf/assets/NotoSans-OFL.txt).
- **ESCO** — the skills list in `packages/jobs-kit/assets/skills.json` uses the
  ESCO classification of the European Commission (https://esco.ec.europa.eu),
  v1.2.1, modified (a subset of skill concepts and labels). ESCO is not
  responsible for this version.
- **O\*NET 31.0** — the same skills list incorporates information from the
  O\*NET 31.0 Database by the U.S. Department of Labor, Employment and Training
  Administration (USDOL/ETA), used under CC BY 4.0 and modified. O\*NET® is a
  trademark of USDOL/ETA, which has not approved, endorsed or tested these
  modifications.

## Test fixtures

Fixtures used only by tests record their own sources and licences beside
them: [`packages/test-support/fixtures/jobs/README.md`](packages/test-support/fixtures/jobs/README.md)
(including TechWolf Skill-XL, CC BY 4.0) and
[`packages/test-support/fixtures/places/README.md`](packages/test-support/fixtures/places/README.md)
(OpenStreetMap data © OpenStreetMap contributors, ODbL, open-government
datasets, and a few samples whose terms are noted there).
