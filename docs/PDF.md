# PDFs: reading them and filling forms

Tavi reads PDFs and fills PDF forms with six built-in tools. This page is for
the person using them; how they fit with the rest of Tavi is in
[CONCEPTS.md](CONCEPTS.md#pdfs).

## What a chat can do

Send a PDF in a chat (a Telegram attachment, or one attached in the canvas's
composer), or point at one in the chat's folders, and ask about it.

- **`pdf.read`**: the text, page by page (`pages`, such as `1-5,9`), or only the
  pages that contain a phrase (`find`). Text hidden from a reader — white on
  white, tiny, invisible, off the page, in a hidden layer, or covered by a shape
  or an image — comes back apart, under `hidden`, so a planted instruction is
  read as data and you can be told it was there. With the OCR add-on, a scanned
  page is read too (see *Scanned pages* below). `format: "markdown"` gives each
  page in reading order — a two-column page column by column — with ruled or
  three-column tables as Markdown tables, headings marked, and running headers
  and footers dropped (see *Layout* below).
- **`pdf.fields`**: a form's fields: each one's id, type, page, label, current
  value, options (the value to write and what the form shows), whether it is
  required, read-only or hidden, and which are yours to sign or attest. A form
  with no fields lists its entry boxes instead (see *Harder forms* below).
- **`pdf.render`**: up to three pages as images, for a vision model to look at
  a scanned or handwritten page or a layout, with form fields outlined on
  request.
- **`pdf.view`**: hands the model a short PDF whole, layout, tables and figures
  included, where its connection takes PDFs (see *A PDF sent whole* below);
  anywhere else, its text and first pages as images stand in for it.
- **`pdf.fill`**: fills a form into a new copy, after `pdf.fields`.
- **`pdf.overlay`**: writes on a printed form with no fields, at the entry
  boxes `pdf.fields` lists, into a new copy (see *Harder forms* below).

A PDF is read only from an approved attachment of the same chat (an attachment belongs to the chat its message started or joined) or from a
file the chat may read (its own folder and the folders attached to it); the
text it returns carries where it came from, so a document someone sent you
counts as untrusted content (see [Why am I asked, and from where](SECURITY-MODEL.md#why-am-i-asked-and-from-where)).

In the canvas, the composer's paperclip takes PDFs of up to 20 MiB beside text
files. A PDF is uploaded in pieces when you send, and the owner keeps it only
when its bytes are a PDF: a file merely renamed `.pdf` is refused at its first
piece. It is kept as a channel attachment is, an approved, untrusted artifact
labelled `attachment`, and the message names it with the same line a Telegram
attachment leaves, quoted apart from your words. A message with a PDF is its
own turn, never merged into one still running. Erasing the chat erases the
files its messages carried; a file uploaded for a message that was never
admitted (refused, or still queued when the page closed) belongs to no chat
and is not erased with any chat.

## Filling a form

Every value the agent fills names where it came from:

| Source | Example | Checked how |
| --- | --- | --- |
| A file or an attachment | `leo_medical.yaml`: "MMR 2016-03-02" | The quoted words must be in the file, and the value must be what they say. Text files only, never the form itself; an attachment must be one this conversation was sent, and the card says who sent it when it was not you |
| A memory record | your saved address | The record must be one you approved and may read |
| Your words | "Leo Ivanov" from your message | Looked up in your recent messages |
| The form's own words | "see page 2" | Shown as such; never counted as checked |
| A choice | ticking "Yes" because you agreed above | Must follow from an earlier, checked value |

A value may be the same words, the same words in another case, the same
digits ("(555) 010-2030" for `5550102030`), the same date in another format
("March 4, 2016" for `03/04/2016`, but never an ambiguous `03/04/2016` as a
source; one part of it, such as "03", only in a box whose label names that
part), or an option the form shows by that name, as whole words ("Female"
never names "Male", and a quote naming two options names neither). A box whose
ticked state is a bare "On", "1" or "X" is ticked only by a quote whose answer
is exactly that. A value whose file,
attachment or memory record does not say it is refused **before** you are
asked, naming the field; nothing is written.

You approve every value once, in one table. The fill then reads every source
again: if a file, an attachment or a memory record changed since you approved,
nothing is written.

**What Tavi never fills.** Signature, initials and "I certify"/"I attest"
fields stay blank, listed under "You sign or complete these yourself". Hidden,
read-only and duplicate fields are left alone.

**The copy.** A fill writes a new file and never writes over one: by default
`forms/<form>-filled.pdf` in the chat's own folder, `<form>` the file's own
name, an attached form's too (then
`forms/<form>-filled (2).pdf`, and so on). The copy is written without the
form's scripts and other active content, and every field is read back before it
is kept. A chat started from a messaging channel always writes to its `forms/`;
sending the copy somewhere is a separate, approved send.

**What is refused**, with a sentence on what to do instead: XFA-only forms
(ask for a plain fillable PDF), a form certified against any change (DocMDP
P1), a field a signature locks, a signed form that carries scripts, and values
the form cannot take (a wrong option, too long, the wrong kind). An encrypted
form — with permissions only, or opened with its password — gets an **answer
sheet**, a PDF listing each field and its value to copy into the form by hand,
instead of a filled copy: its restrictions are never removed. Only Latin,
Greek and Cyrillic values can be filled: the built-in font covers those, and no
font add-on exists yet, so a Chinese, Japanese, Korean, Arabic, Hebrew, Thai or
Devanagari value is refused. A call whose values do not fit the tool (a
source kind that is none of `file`, `attachment`, `memory`, `person`,
`document` or `choice`) is refused before any card, saying what is wrong.

## Harder forms

- **Signed forms**, and forms certified to allow filling (DocMDP P2 and P3), are
  filled by an update appended after the signed bytes, so the signature still
  covers the original and a validator lists the values as form filling. The
  copy is kept only when the original is its byte-for-byte prefix and its
  signatures and certification read back unchanged. A field the signature's
  `/Lock` covers (or every field, under PDF 2.0's "no changes") is refused, and
  so is a signed form with scripts: they cannot be removed without changing
  what was signed.
- **XFA hybrids**, a form with both an XFA layer and fields, are filled through
  their fields; the copy drops the XFA layer (its packets too), so it looks as
  its fields do, and the card says so.
- **A final copy**: ask for one and the fill is flattened (`flatten: true`) —
  each field's appearance drawn into its page and the fields removed, kept only
  when each text value's first words are on its page. Refused while the form
  leaves a field for you to sign or complete, for a signed form, and for an
  encrypted one whose permissions do not allow changing its pages; an encrypted
  one whose permissions allow it gets an answer sheet, as any encrypted form
  does.
- **A PDF with a password**: set it on the host as a credential,
  `tavi credentials set pdf.<its sha256>` — the refusal names it, and no other
  document opens with it. The owner reads it and hands it only to the PDF process; it
  is never a tool input, never in a result, and never sent to a model. Such a
  PDF is read, listed and rendered; filled only on an answer sheet; never handed
  to a model whole. A password set on the host is used from a messaging channel
  too; with none set, the channel is asked for an unlocked copy.
- **Flat forms**, printed forms with no fields: `pdf.fields` lists their entry
  boxes on the first 50 pages — an underline (the line above it), or an empty
  box a line high, with nothing written in or over it — each named by the text
  beside it, as `p<page>.b<n>`. `pdf.overlay` writes each
  value over its box as a FreeText annotation, one line, sized to fit (refused
  when it cannot fit at 6 points), with the same sources, approval and card as
  `pdf.fill`; a signature, initials or "I certify" line stays yours. The values
  are read back from the copy before it is kept.

## Where you approve a fill

| Where | What it shows | Can approve |
| --- | --- | --- |
| The canvas, `tavi chat` | Every value in full, by page, with its source and whether it was found | Yes |
| Your own one-to-one chat (Telegram) | Sensitive values masked: an ID, card, insurance or phone number to its last four, a date of birth to its year, an email address to its first letter and domain, health details hidden, each without its quoted source | Only when every masked value was found in its source and every row was shown; otherwise reject only |
| A group, a topic, an email | The field names only | No (reject only) |
| An email's link page | The masked table, when the email carries links and every masked value was found in its source | Through the link; otherwise the email can only reject |

A fill is never run by a schedule, a routine or a heartbeat: it always waits for
a person. Each approval is for that one fill.

After the fill, the canvas shows a review panel: the filled pages on the left;
on the right every value written, with its source and how it was checked, the
fields left blank for you to sign or complete, those still required, and a
Download button for the filled copy (read from the chat's folder and checked
against its SHA-256 before it is saved).

## Turning it off, and what runs where

```bash
tavi config set pdf.enabled off
```

turns the PDF tools off in a workspace (they refuse). `tavi doctor` reports
the setting and how PDFs are parsed on this host.

## Scanned pages, and text something is drawn over

A scanned page is a picture of text, with little or no text to read. With the
**OCR add-on**, `@tavi/pdf-ocr`, installed where `tavi` is installed, `pdf.read`
renders such a page and reads it with Tesseract (English), in a second
single-use process apart from the PDF parser, which fetches nothing; up to 10
pages a call, and the rest in a later call. Without the add-on, or with
`ocr: "off"`, the result names the pages that are images, so the agent looks at
them with `pdf.render` (a vision model) instead. Handwriting is not promised
either way: `pdf.render` and a vision model are the way to read it.

Text can also be hidden by drawing something over it: a white box, an image, a
stamp. The parser notes where text lies under something opaque drawn after it;
with the add-on, those pages are rendered and read first, and text the render
does not show moves to `hidden` as `covered`. If that check cannot run (the
call's limit, a failed render, a render read with low confidence) the text is
moved anyway, and the result says it was not confirmed. Without the add-on the
text stays, and the result names the pages where something is drawn over text
that was not checked; so it does, with the add-on, for a `find` read (its
snippets), a page with more than 20,000 drawing objects, and covered text past
what one read returns.

## Layout

With `format: "markdown"`, `pdf.read` lays each page out from its positioned
text: a page is cut at full-width gaps into bands, and a band at full-height
gaps into columns, read in turn; lines close together make a paragraph, and a
short line set larger than the page's body text is a heading. Three or more
lines, opening with a full row, whose words start at column positions each
shared by at least half of them, are a table when ruling lines run across them,
or when they have three or more columns of short cells; columns of prose, however
aligned, are a page in columns, not a table. A line at the top or bottom of the
page that repeats on at least three pages, and on at least half the pages read,
is a running header or footer, and is dropped; a standalone page number may
differ between the repeats, an amount may not. Text under something drawn over
it is left out of Markdown unchecked, and its page is named as not checked
whole: read it in `text` format, with the OCR add-on, to check it. On a page
with more than 20,000 drawing objects covers are not looked for, so covered text
there may stay in; that page is named as not checked whole all the same. A
page of more than 5,000 text runs is read line by line, without layout.

For harder documents — scanned tables, forms with complex structure,
scientific papers — heavier parsers are your own add-ons: Docling as an MCP
server (see [MCP.md](MCP.md)), or pdfplumber in `sandbox.run` on a copy of the
PDF in the chat's folder. Tavi ships neither.

## A PDF sent whole

Some model connections take a PDF as a file and read it themselves, layout and
all. Tavi sends one only where the connection is known to take it:

- **On by default** for the OpenAI and OpenRouter endpoints (`pdfInput:
  openai-file`), **off** everywhere else, and **never** for Anthropic's
  OpenAI-compatible endpoint, which drops files silently.
- **Anywhere else**, `tavi models probe <id> --pdf` checks it: the model is sent
  a one-page PDF holding a random code, and PDF input goes on only when the
  model quotes the code back. `tavi models add <id> ... --pdf-input none` turns
  it off; `--pdf-engine` picks OpenRouter's file parser.
- **Only to a model that reads images** (OpenAI reads PDFs with its vision
  models), or any model through OpenRouter, which parses the file for it.

`pdf.view` hands a PDF over whole only when the whole of it was read and nothing
in it hides from a reader: at most 40 pages and 20 MiB, no hidden or covered
text, no form fields, no comments or notes, no active content, and no password
— a model's own PDF reader would take those in unchecked. Anything else is answered with its text and first
pages, and the result says why. A PDF is sent in the turn it was viewed in, not
again in later turns. Under the cache-stable prompt layout (`models.promptLayout
v2`) the result reads the same in either case (it says when the file is sent and
that its text and pages stand for it otherwise), so an earlier turn's result is
sent byte for byte as before.

## The PDF processes

Each PDF is parsed by a fresh, single-use child process with capped memory and
time. It runs under the sandbox with no network and nothing it can write: on
macOS always, and on Linux whenever the sandbox works there. While it does
not (`tavi sandbox check` says why, and how to fix it), PDF calls are refused
before any child starts, as the video tools are, unless the owner started
`tavi serve --pdf-allow-unconfined`: then the child runs unconfined, still
WebAssembly and capped in memory and time. `tavi doctor`'s `pdf` section says
which (`confinement`: `srt`, `refused` or `unconfined`). A refused call says
nothing about the document, so it is not held against it: once the sandbox
works (the tier is read at each call, with no restart), the same PDF reads at
once. OCR runs in a second such process, which may
also read the OCR add-on's own directory. A document that made a child run out
of time or memory, crash, or answer out of protocol is refused for a day, or
until the owner restarts.

The parts are replaceable plugins that meet only at contracts: the engine
(`@tavi/plugin-pdf`) implements `PdfEnginePort`; the OCR add-on
(`@tavi/pdf-ocr`) is a set of files (`PdfOcrAssets`) the engine is handed, never
imports; the tools use the engine only through the port. The owner puts them
together in one place (`apps/cli/src/features/pdf/host.ts`), with its sandbox, and a
different engine can stand in for the built-in one there.

Page previews a fill or a render made are kept with the chat and deleted when
you forget its history; the filled copy is yours and stays.

## Architecture

PDF parsing, hidden-text detection, OCR, and form filling are isolated behind `PdfEnginePort` and wired in a single CLI host module (`apps/cli/src/features/pdf/host.ts`, enforced by [`tests/boundaries.test.ts`](../tests/boundaries.test.ts)):

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Contracts & Ports** | `packages/contracts/src/pdf.ts`, `pdf-engine.ts`, `pdf-classify.ts`, `protected-fields.ts` | `PdfEnginePort`, `PdfOcrAssets`, `pdf.*` tool schemas, field classification, and source-verification contracts. |
| **PDF Engine (`@tavi/plugin-pdf`)** | `packages/builtin/pdf/src/host.ts`, `engine.ts`, `child.ts`, `read-pdfium.ts`, `write-pdflib.ts`, `hidden-text.ts`, `layout.ts`, `boxes.ts`, `labels.ts`, `ocr.ts`, `ocr-child.ts`, `png.ts`, `pdfium.ts`, `assets.ts`, `protocol.ts` | Implements `PdfEnginePort`: spawns single-use sandboxed child processes (`child.ts`, `ocr-child.ts`) using `@tavi/child-kit`, reads positioned text and geometry via WebAssembly PDFium (`read-pdfium.ts`), detects covered/hidden text (`hidden-text.ts`), reconstructs Markdown tables/columns (`layout.ts`), and fills/overlays forms via `pdf-lib` (`write-pdflib.ts`). |
| **OCR Add-on (`@tavi/pdf-ocr`)** | `packages/pdf-ocr/src/index.ts` | Optional asset bundle (`PdfOcrAssets`) handed to `@tavi/plugin-pdf` at composition time without a direct package dependency. |
| **Single-Owner Wiring & Tools** | `apps/cli/src/features/pdf/host.ts`, `apps/cli/src/features/pdf/tools.ts` | Single point where `@tavi/plugin-pdf` and `@tavi/pdf-ocr` are wired with `ConfinementPort`; registers `pdf.read`, `pdf.fields`, `pdf.render`, `pdf.view`, `pdf.fill`, and `pdf.overlay`. |

See [ARCHITECTURE.md](ARCHITECTURE.md) and [evals/pdf/README.md](../evals/pdf/README.md) for the PDF evaluation corpus.
