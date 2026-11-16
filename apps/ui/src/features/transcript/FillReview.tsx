import { errorMessage, isRecord } from "@tavi/contracts/util";
import { createContext, useContext, useState } from "react";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Notice } from "../../ui/Parts.js";
import { FormFillTable } from "./FormFillTable.js";
import { Button } from "../../ui/Button.js";

/**
 * How the transcript reads a PDF page preview a fill or render stored: a
 * `data:` URL, or why not. Absent, the card lists the pages
 * without their images.
 */
export const PreviewImageContext = createContext<
  | ((artifactId: string) => Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }>)
  | undefined
>(undefined);

/**
 * How the review panel saves a filled form: the file at its
 * shown path in the chat's folder, or why it was not saved. Absent, the path
 * is shown without a download.
 */
export const FillDownloadContext = createContext<((path: string) => Promise<string | undefined>) | undefined>(undefined);

/** One page preview, read when the card is opened. */
/** A preview artifact's image, read through the page's preview reader; undefined until it has come (or when none is wired). */
export function usePreviewImage(artifactId: string): string | undefined {
  const read = useContext(PreviewImageContext);
  const { data } = useLoaded(
    async () => (read === undefined ? ({ ok: false, message: "No preview reader" } as const) : read(artifactId)),
    [read, artifactId],
    { enabled: read !== undefined },
  );
  return data;
}

export function PdfPage({ page, artifactId }: { readonly page: number; readonly artifactId: string }) {
  const src = usePreviewImage(artifactId);
  return (
    <figure className="pdf-page">
      {src === undefined ? <div className="pdf-page-empty" aria-hidden="true" /> : <img src={src} alt={`Page ${page}`} />}
      <figcaption className="meta-sm">Page {page}</figcaption>
    </figure>
  );
}

/** The preview artifacts a `pdf.fill` (`previews`) or `pdf.render` (`images`) result names, by page: at most 12. */
export function pdfPagesOf(output: unknown): readonly { readonly page: number; readonly artifactId: string }[] {
  if (typeof output !== "object" || output === null) return [];
  const list =
    (output as { readonly previews?: unknown; readonly images?: unknown }).previews ?? (output as { readonly images?: unknown }).images;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((entry: unknown) => {
      const { page, artifactId } = (typeof entry === "object" && entry !== null ? entry : {}) as {
        readonly page?: unknown;
        readonly artifactId?: unknown;
      };
      return typeof page === "number" && typeof artifactId === "string" ? [{ page, artifactId }] : [];
    })
    .slice(0, 12);
}

type Row = { readonly field: string; readonly value: string; readonly source: string; readonly check: string; readonly checkWords: string };

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** A value as the form shows it: a box ticked or not, a list's picks. */
function shownValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "ticked" : "not ticked";
  if (Array.isArray(value)) return strings(value).join(", ");
  return text(value);
}

/**
 * A row's source, and what the gate held it to before the person was asked:
 * a file, attachment or memory source that did not hold the value was
 * denied, so a fill that ran found each; the person's words, the form's own
 * and a choice are what they are.
 */
function sourceOf(
  source: Record<string, unknown> | undefined,
  rows: readonly Record<string, unknown>[],
): Pick<Row, "source" | "check" | "checkWords"> {
  const quote = `"${text(source?.["quote"])}"`;
  switch (source?.["kind"]) {
    case "file":
      return { source: `${text(source["path"])}: ${quote}`, check: "verified", checkWords: "found in its source" };
    case "attachment":
      return { source: `attachment ${text(source["artifactId"])}: ${quote}`, check: "verified", checkWords: "found in its source" };
    case "memory":
      return { source: `memory: ${quote}`, check: "verified", checkWords: "found in its source" };
    case "person":
      return { source: `your words: ${quote}`, check: "your words", checkWords: "your own words, checked when you approved" };
    case "document":
      return { source: `the form, page ${String(source["page"])}: ${quote}`, check: "the form's", checkWords: "the form's own words" };
    case "choice": {
      const from = typeof source["from"] === "number" ? rows[source["from"]] : undefined;
      return {
        source: `a choice from ${from === undefined ? "an earlier row" : text(from["field"])}${text(source["note"]) === "" ? "" : `: ${text(source["note"])}`}`,
        check: "a choice",
        checkWords: "a choice, not a copy",
      };
    }
    default:
      return { source: "", check: "", checkWords: "" };
  }
}

/** A fill's rows, from the call's input: every value written, with its source. */
function rowsOf(input: unknown): readonly Row[] {
  const raw = record(input)?.["values"];
  const values = (Array.isArray(raw) ? (raw as unknown[]) : [])
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  return values.map((entry) => ({
    field: text(entry["field"]),
    value: shownValue(entry["value"]),
    ...sourceOf(record(entry["source"]), values),
  }));
}

/**
 * The review panel of a completed fill: the filled pages on the
 * left; on the right every value with its source and check, what was left
 * blank for the person, and the filled copy to download. Every string is the
 * document's, a source's or the model's, so React's escaping is all it gets.
 */
export function FillReview({ input, output }: { readonly input: unknown; readonly output: unknown }) {
  const result = record(output);
  const download = useContext(FillDownloadContext);
  const [saving, setSaving] = useState<"idle" | "saving" | { readonly failed: string }>("idle");
  const path = text(result?.["output"]);
  const previews = pdfPagesOf(output);
  const left = record(result?.["left"]);
  const userOnly = strings(left?.["userOnly"]);
  const required = strings(left?.["required"]);
  const rows = rowsOf(input);
  const save = (): void => {
    if (download === undefined || saving === "saving") return;
    setSaving("saving");
    void download(path)
      .then((failed) => setSaving(failed === undefined ? "idle" : { failed }))
      .catch((error: unknown) => setSaving({ failed: errorMessage(error) }));
  };
  return (
    <div className="fill-review">
      <div className="fill-review-pages pdf-pages" role="group" aria-label="Filled pages">
        {previews.map((entry) => (
          <PdfPage key={entry.artifactId} page={entry.page} artifactId={entry.artifactId} />
        ))}
      </div>
      <div className="fill-review-side form-fill">
        {result?.["answerSheet"] === true ? (
          <Notice>The form could not be filled: this is an answer sheet to copy onto it by hand.</Notice>
        ) : null}
        <FormFillTable>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{row.field}</td>
                <td>{row.value}</td>
                <td className="meta-sm">{row.source}</td>
                <td className="form-check meta-sm" title={row.checkWords}>
                  {row.check}
                </td>
              </tr>
            ))}
          </tbody>
        </FormFillTable>
        {result?.["verified"] === false ? (
          <Notice>Not every value read back as written: check the filled copy before you use it.</Notice>
        ) : null}
        {userOnly.length === 0 ? null : <p className="meta-sm">Left blank for you to sign or complete: {userOnly.join(", ")}</p>}
        {required.length === 0 ? null : <p className="meta-sm">Required, still blank: {required.join(", ")}</p>}
        {path === "" ? null : (
          <p className="meta-sm fill-review-download">
            <code>{path}</code>{" "}
            {download === undefined ? null : (
              <Button size="sm" aria-busy={saving === "saving"} onClick={save}>
                {saving === "saving" ? "Downloading…" : "Download"}
              </Button>
            )}
          </p>
        )}
        {typeof saving === "object" ? <Notice role="alert">{saving.failed}</Notice> : null}
      </div>
    </div>
  );
}
