import type { ArtifactRepositoryPort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { ARCHIVED_PREVIEW_CHARS, collectPendingReviewArtifactIds, previewOf } from "../src/workflow/tool-output.js";

/** What the model is shown in place of an archived result: its shape, shortened, within the preview's bound. */
describe("previewOf", () => {
  it("cuts a long string to its head and tail, keeping the end a log's error is at", () => {
    const preview = JSON.parse(previewOf({ log: `start ${"x".repeat(50_000)} ERROR at the end` })) as { log: string };
    expect(preview.log.startsWith("start ")).toBe(true);
    expect(preview.log.endsWith("ERROR at the end")).toBe(true);
    expect(preview.log).toContain("characters left out");
  });

  it("keeps a long list's first items and says how many more there were, nested ones too", () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: index, note: `row ${index} ${"y".repeat(40)}` }));
    const preview = JSON.parse(previewOf({ result: { rows } })) as { result: { rows: unknown[] } };
    expect(preview.result.rows.length).toBeLessThan(rows.length);
    expect(preview.result.rows.at(-1)).toMatch(/more items left out/);
    expect((preview.result.rows[0] as { id: number }).id).toBe(0);
  });

  it("stays within its bound, falling back to the head of the JSON when no cap fits", () => {
    const wide = Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`key${index}`, index]));
    const preview = previewOf(wide);
    expect(preview.length).toBeLessThanOrEqual(ARCHIVED_PREVIEW_CHARS);
    expect(preview.startsWith('{"key0":0')).toBe(true);
  });
});

/** The artifacts a tool's result names that wait for review: what suspends the turn on them. */
describe("collectPendingReviewArtifactIds", () => {
  const artifacts = {
    getArtifact: async (artifactId: string) =>
      artifactId === "art-download"
        ? { artifactId, workspaceId: "w1", reviewState: "pending" }
        : artifactId === "art-other"
          ? { artifactId, workspaceId: "w2", reviewState: "pending" }
          : undefined,
  } as unknown as ArtifactRepositoryPort;

  it("finds a browser download a click started, named by the action's outcome", async () => {
    // `browser.act` `download`'s outcome, as the Playwright adapter returns it.
    const outcome = { status: "accepted", detail: "saved as artifact art-download", artifactId: "art-download" };
    expect(await collectPendingReviewArtifactIds(artifacts, "w1", outcome)).toEqual(["art-download"]);
    // In a batch step too.
    expect(await collectPendingReviewArtifactIds(artifacts, "w1", { steps: [outcome] })).toEqual(["art-download"]);
  });

  it("does not take an id from prose, nor another workspace's artifact", async () => {
    expect(
      await collectPendingReviewArtifactIds(artifacts, "w1", { status: "accepted", detail: "saved as artifact art-download" }),
    ).toEqual([]);
    expect(await collectPendingReviewArtifactIds(artifacts, "w1", { artifactId: "art-other" })).toEqual([]);
  });
});
