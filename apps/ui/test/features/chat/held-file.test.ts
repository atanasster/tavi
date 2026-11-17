import { describe, expect, it } from "vitest";
import type { ArtifactListRow } from "@tavi/contracts";
import { fileFacts, fileKind, fileTag, fileTitle, showsImage } from "../../../src/features/chat/held-file.js";

const row = (overrides: Partial<ArtifactListRow>): ArtifactListRow => ({
  artifactId: "art-1",
  workspaceId: "default",
  runId: "task-1",
  contentType: "image/jpeg",
  byteSize: 145_844,
  reviewState: "approved",
  ...overrides,
});

describe("a held file, in words", () => {
  it("names what a file is, and tags its tile", () => {
    expect(fileKind("image/jpeg")).toBe("JPEG image");
    expect(fileKind("application/pdf")).toBe("PDF");
    expect(fileKind("text/plain; charset=utf-8")).toBe("Text file");
    expect(fileKind("application/zip")).toBe("ZIP file");
    expect(fileKind("application/vnd.ms-excel")).toBe("MS-EXCEL file");
    expect(fileKind("application/octet-stream")).toBe("File");
    expect(fileTag("image/jpeg")).toBe("JPG");
    expect(fileTag("text/plain")).toBe("TXT");
    expect(fileTag("application/octet-stream")).toBe("FILE");
  });

  it("calls a file by its own name, else by what it is, with its size", () => {
    expect(fileTitle(row({}))).toBe("JPEG image");
    expect(fileTitle(row({ fileName: "report.pdf", contentType: "application/pdf" }))).toBe("report.pdf");
    expect(fileFacts(row({}))).toBe("142.4 KiB · JPEG image");
  });

  it("shows the picture of an approved image the owner serves, and of nothing else", () => {
    expect(showsImage(row({}))).toBe(true);
    expect(showsImage(row({ reviewState: "pending" }))).toBe(false);
    expect(showsImage(row({ contentType: "image/gif" }))).toBe(false);
    expect(showsImage(row({ byteSize: 5 * 1024 * 1024 }))).toBe(false);
  });
});
