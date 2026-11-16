import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteStore } from "../support/database-fixture.js";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi reports show|open`. The brief is stored as an
 * artifact rather than returned by a tool, so this is the operator's only way to
 * read it — and `show` must never spill the document itself.
 */

const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

/** Seed a data directory with one stored artifact, as `reports.generate` would. */
async function seededReport(
  bytes: Uint8Array,
  options: { readonly contentType?: string; readonly reviewState?: "pending" | "approved" | "rejected" } = {},
): Promise<{ readonly directory: string; readonly artifactId: string }> {
  const directory = directories.create("tavi-report-cmd-");
  const store = await SqliteStore.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  try {
    const record = await store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      runId: "run-1",
      contentType: options.contentType ?? "application/pdf",
      body: bytes,
      reviewState: options.reviewState ?? "approved",
    });
    return { directory, artifactId: record.artifactId };
  } finally {
    store.close();
  }
}

describe("tavi reports show", () => {
  it("prints metadata for a stored report and never its body", async () => {
    const body = new TextEncoder().encode("%PDF-1.4 fake brief bytes");
    const { directory, artifactId } = await seededReport(body);

    const captured = capture();
    expect(await main(["reports", "show", artifactId, "--format", "json", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    const printed = JSON.parse(captured.stdout()) as Record<string, unknown>;
    expect(printed["artifactId"]).toBe(artifactId);
    expect(printed["contentType"]).toBe("application/pdf");
    expect(printed["byteSize"]).toBe(body.byteLength);
    expect(printed["reviewState"]).toBe("approved");
    // The document itself is not the metadata command's business.
    expect(captured.stdout()).not.toContain("%PDF");
  });

  it("reports an unknown artifact as unavailable", async () => {
    const { directory } = await seededReport(new Uint8Array([1, 2, 3]));
    const captured = capture();
    expect(await main(["reports", "show", "art-nope", "--data-dir", directory], { io: captured.io })).toBe(EXIT.unavailable);
    expect(captured.stderr()).toContain("no artifact");
  });
});

describe("tavi reports open", () => {
  it("writes the document to the operator's path and prints it", async () => {
    const body = new TextEncoder().encode("%PDF-1.4 fake brief bytes");
    const { directory, artifactId } = await seededReport(body);
    const out = join(directory, "brief.pdf");

    const captured = capture();
    expect(await main(["reports", "open", artifactId, "--out", out, "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    expect(captured.stdout().trim()).toBe(out);
    expect(new Uint8Array(readFileSync(out))).toEqual(body);
  });

  it("requires --out and an artifact id", async () => {
    const { directory, artifactId } = await seededReport(new Uint8Array([1]));
    expect(await main(["reports", "open", artifactId, "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
    expect(await main(["reports", "open", "--out", "/tmp/x", "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
    expect(await main(["reports", "frobnicate", artifactId, "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
  });

  it("refuses to materialize an artifact that is not a report", async () => {
    // Without this the command is a general artifact-read primitive: any id in
    // the data directory could be written to any path.
    const { directory, artifactId } = await seededReport(new Uint8Array([1]), { contentType: "application/json" });
    const captured = capture();
    const out = join(directory, "leak.json");
    expect(await main(["reports", "open", artifactId, "--out", out, "--data-dir", directory], { io: captured.io })).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("not a report");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to materialize an undecided artifact, but still shows its metadata", async () => {
    const { directory, artifactId } = await seededReport(new Uint8Array([1]), { reviewState: "pending" });
    const out = join(directory, "undecided.pdf");
    const opened = capture();
    expect(await main(["reports", "open", artifactId, "--out", out, "--data-dir", directory], { io: opened.io })).toBe(EXIT.reviewRequired);
    expect(existsSync(out)).toBe(false);

    const shown = capture();
    expect(await main(["reports", "show", artifactId, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain("pending");
  });

  it("renders show as text by default and JSON on request", async () => {
    const { directory, artifactId } = await seededReport(new TextEncoder().encode("%PDF-1.4 x"));
    const text = capture();
    expect(await main(["reports", "show", artifactId, "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    expect(text.stdout()).toContain(artifactId);
    expect(text.stdout()).not.toContain("{");

    const json = capture();
    expect(await main(["reports", "show", artifactId, "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect((JSON.parse(json.stdout()) as { artifactId: string }).artifactId).toBe(artifactId);
  });
});
