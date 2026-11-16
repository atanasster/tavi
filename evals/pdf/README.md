# PDF eval

The fixture suite and yardstick for reading PDFs and filling PDF forms
([PDF.md](../../docs/PDF.md)).

- `build-fixtures.ts` — builds all 54 fixtures from code, byte-identical on
  every run, so no third-party PDF is committed. Most forms come from
  `@cantoo/pdf-lib`, and the malformed ones are hand-written bytes. The
  encrypted ones use the standard security handler in the same file
  (RC4-128 R3, AES-256 R6), because the library's own `encrypt()` leaves
  strings in the clear. `node evals/pdf/build-fixtures.ts [--out <dir>]` writes
  them, by default to `fixtures/` (git-ignored), with `leo_medical.yaml` for use
  case 12.1.
- `manifest.json` — what each fixture must show. It covers facts, fields
  (type, label, options with `shownFrom`, on-states, flags, classification),
  visible and hidden text, native search, rendering and outline alignment,
  fills with read-back, the active content left in the output, and comb
  cells. It also covers refusals and containment. A fixture marked `pending`
  names the phase that closes its gap.
- `eval.ts` — runs every fixture through the owner's PDF service and the
  built, single-use child, checks it against the manifest, and records what
  each cost. It also records cold and warm start, search across the 200-page
  manual, framing at its caps, the child's thread count and the installed
  footprint. Its pure parts are tested in `tests/pdf-eval.test.ts`, which also
  runs the safety-relevant fixtures.
- `results/` — one JSON report per run (git-ignored).

## Run

Build `@tavi/plugin-pdf` first (`pnpm --filter @tavi/plugin-pdf build`): the
eval spawns `dist/child.mjs`.

```bash
node evals/pdf/eval.ts --label p0
node evals/pdf/eval.ts --fixture school-packet,flate-bomb
```

It exits 0 when no fixture failed. Pending fixtures do not fail it.

## Groups

| Group | Fixtures |
| --- | --- |
| Mechanics | `opt-combo`, `radio-opt`, `radio-nearby-only` (deceptive nearby labels), `checkbox-onvalue` (`Yes`, `1`, `On`), `multi-widget`, `rotated-90` |
| AcroForm | `school-packet` (10 pages, 120 field names: every kind, a signature line, "Parent signature", "I certify…", required, read-only, hidden, a duplicate name), `unicode-values`, `comb-and-format` |
| XFA | `xfa-hybrid`, `xfa-dynamic` |
| Scanned | `scan-printed`, `scan-handwritten`, `ocr-layer` |
| Encrypted | `owner-only-fill`, `owner-only-nofill`, `user-password`, `aes256` |
| Signed | `signed`, `certified-p1`, `certified-p2` (structural signatures, never validated) |
| Active content | `js-openaction`, `field-aa-scripts`, `submitform-on-close`, `launch`, `gotor-smb`, `embedded-exe`, `richmedia`, `xfa-xxe` |
| Resource | `flate-bomb` (300 MiB of zeros), `xref-loop`, `outline-cycle`, `deep-nesting`, `huge-image`, `page-bomb` (100,000 pages), `jbig2-malformed`, `fontmatrix-cve-2024-4367` |
| Injection | `hidden-render-mode-3`, `hidden-white-on-white`, `hidden-tiny`, `hidden-off-page`, `hidden-ocg-off`, `hidden-covered`, `zero-width` (see below), `instruction-in-field-tooltip` |
| Type confusion | `not-a-pdf.pdf`, `polyglot`, `truncated`, `empty`, `zero-page`, `linearized` (object streams) |
| Reading | `manual` (200 pages), `two-column-paper`, `tables` |

`zero-width` cannot carry its characters: the core font has no zero-width
glyphs, so pdf-lib draws none. The detection is tested on characters directly
in `packages/builtin/pdf/test/hidden-text.test.ts`.
