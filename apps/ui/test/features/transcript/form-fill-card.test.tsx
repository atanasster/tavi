// @vitest-environment jsdom
import type { ToolCard } from "@tavi/client/browser";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { FormTable } from "../../../src/features/chat/ApprovalParts.js";
import { FillDownloadContext, FillReview } from "../../../src/features/transcript/FillReview.js";
import { PreviewImageContext } from "../../../src/features/transcript/FillReview.js";
import { rendererFor } from "../../../src/features/transcript/ToolCards.js";
import { mount } from "../../support/dom.js";

/**
 * A form fill on the canvas: every value
 * in full, grouped by page, with its source and check; the document's words
 * inert; and the filled pages beside the result.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const form = {
  source: "registration.pdf, 2 pages",
  output: "forms/registration-filled.pdf",
  rows: [
    { page: 1, field: "Child name", value: "Leo Ivanov", source: 'your words: "Leo Ivanov"', status: "verified" as const },
    {
      page: 2,
      field: "<img src=x onerror=alert(1)>",
      value: "MMR 2016-03-02",
      source: 'leo_medical.yaml: "MMR 2016-03-02"',
      status: "unmatched" as const,
      sensitive: ["health" as const],
    },
  ],
  leftBlank: [{ field: "Parent signature", why: "signature" as const }],
  warnings: ["the form carries JavaScript; the copy is written without it"],
};

describe("the form fill card", () => {
  it("shows every value in full by page, with its source and check, and the document's words inert", async () => {
    const shown = await mount(<FormTable form={form} />);
    expect([...shown.querySelectorAll("th[scope=rowgroup]")].map((cell) => cell.textContent)).toEqual(["Page 1", "Page 2"]);
    const rows = [...shown.querySelectorAll("tbody tr")]
      .filter((row) => row.querySelector("td") !== null)
      .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Child name", "Leo Ivanov", 'your words: "Leo Ivanov"', "verified"],
      ["<img src=x onerror=alert(1)>", "MMR 2016-03-02 sensitive", 'leo_medical.yaml: "MMR 2016-03-02"', "not found"],
    ]);
    expect(shown.querySelector("img")).toBeNull();
    expect(shown.textContent).toContain("You sign or complete these yourself: Parent signature");
    expect(shown.textContent).toContain("Warning: the form carries JavaScript");
  });

  it("says a truncated table can only be denied", async () => {
    const shown = await mount(<FormTable form={{ ...form, truncated: true }} />);
    expect(shown.textContent).toContain("it can only be denied");
  });

  it("shows a fill's pages beside its result", async () => {
    const card = {
      kind: "tool",
      callId: "c1",
      toolName: "pdf.fill",
      status: "completed",
      input: { output: "forms/a.pdf" },
      output: {
        output: "forms/a.pdf",
        previews: [
          { page: 1, artifactId: "art-1" },
          { page: 2, artifactId: "art-2" },
        ],
      },
    } as unknown as ToolCard;
    const read = async (artifactId: string) => ({ ok: true as const, value: `data:image/png;base64,${artifactId}` });
    const body = rendererFor("pdf.fill").body?.(card);
    const shown = await mount(<PreviewImageContext.Provider value={read}>{body}</PreviewImageContext.Provider>);
    expect([...shown.querySelectorAll(".pdf-page img")].map((image) => image.getAttribute("alt"))).toEqual(["Page 1", "Page 2"]);
    expect(rendererFor("pdf.fill").headline?.(card)).toBe("forms/a.pdf");
  });

  it("reviews a completed fill: pages left, every value with its source and check, what is left blank, and a download", async () => {
    const input = {
      output: "forms/a.pdf",
      values: [
        { field: "Child name", value: "Leo Ivanov", source: { kind: "person", quote: "Leo Ivanov" } },
        { field: "Allergies", value: "none", source: { kind: "attachment", artifactId: "art-in-1", quote: "none" } },
        { field: "Consent", value: true, source: { kind: "choice", from: 0, note: "the parent agreed" } },
        { field: "<b>Clinic</b>", value: "St Mary", source: { kind: "document", page: 2, quote: "St Mary" } },
      ],
    };
    const output = {
      output: "forms/a.pdf",
      verified: false,
      previews: [{ page: 1, artifactId: "art-1" }],
      left: { userOnly: ["Parent signature"], required: ["Date"] },
    };
    const read = async (artifactId: string) => ({ ok: true as const, value: `data:image/png;base64,${artifactId}` });
    const asked: string[] = [];
    const download = async (path: string) => {
      asked.push(path);
      return asked.length === 1 ? undefined : "forms/a.pdf changed while it was downloaded";
    };
    const shown = await mount(
      <PreviewImageContext.Provider value={read}>
        <FillDownloadContext.Provider value={download}>
          <FillReview input={input} output={output} />
        </FillDownloadContext.Provider>
      </PreviewImageContext.Provider>,
    );
    expect([...shown.querySelectorAll(".fill-review-pages img")].map((image) => image.getAttribute("alt"))).toEqual(["Page 1"]);
    const rows = [...shown.querySelectorAll(".fill-review-side tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["Child name", "Leo Ivanov", 'your words: "Leo Ivanov"', "your words"],
      ["Allergies", "none", 'attachment art-in-1: "none"', "verified"],
      ["Consent", "ticked", "a choice from Child name: the parent agreed", "a choice"],
      ["<b>Clinic</b>", "St Mary", 'the form, page 2: "St Mary"', "the form's"],
    ]);
    expect(shown.querySelector("b")).toBeNull();
    expect(shown.textContent).toContain("Left blank for you to sign or complete: Parent signature");
    expect(shown.textContent).toContain("Required, still blank: Date");
    expect(shown.textContent).toContain("Not every value read back as written");
    const button = shown.querySelector(".fill-review-download button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(asked).toEqual(["forms/a.pdf"]);
    expect(shown.querySelector("[role=alert]")).toBeNull();
    await act(async () => button.click());
    expect(shown.querySelector("[role=alert]")?.textContent).toBe("forms/a.pdf changed while it was downloaded");
  });

  it("shows the pages pdf.view rendered to stand in for a document", async () => {
    const card = {
      kind: "tool",
      callId: "c2",
      toolName: "pdf.view",
      status: "completed",
      input: { source: { path: "a.pdf" } },
      output: { images: [{ page: 1, artifactId: "art-v1" }] },
    } as unknown as ToolCard;
    const read = async (artifactId: string) => ({ ok: true as const, value: `data:image/png;base64,${artifactId}` });
    const shown = await mount(
      <PreviewImageContext.Provider value={read}>{rendererFor("pdf.view").body?.(card)}</PreviewImageContext.Provider>,
    );
    expect([...shown.querySelectorAll(".pdf-page img")].map((image) => image.getAttribute("alt"))).toEqual(["Page 1"]);
  });

  it("shows a fill's path without a download where the page cannot save one", async () => {
    const shown = await mount(
      <FillReview input={{ values: [] }} output={{ output: "forms/a.pdf", previews: [], left: { userOnly: [], required: [] } }} />,
    );
    expect(shown.querySelector(".fill-review-download code")?.textContent).toBe("forms/a.pdf");
    expect(shown.querySelector(".fill-review-download button")).toBeNull();
  });
});
