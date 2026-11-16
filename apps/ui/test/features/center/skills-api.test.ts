import type { SkillVersion } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { decideSkill, foreignProvenance, lineDiff, skillEntries } from "../../../src/features/center/skills-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";

/** Settings → Soul & memory's Skills panel: what it lists, how it diffs, and what it sends. */

const version = (skillId: string, number: string, importedAt: string, overrides: Partial<SkillVersion> = {}): SkillVersion => ({
  skillId,
  version: number,
  contentHash: "a".repeat(64),
  scopeKey: "default",
  manifest: { name: `${skillId} ${number}` },
  provenance: "team wiki",
  reviewState: "approved",
  packageArtifactId: `artifact-${skillId}-${number}`,
  importedBy: "operator",
  importedAt,
  ...overrides,
});

describe("the Skills panel's helpers", () => {
  it("lists skills by id, versions newest first, named after the active version", () => {
    const entries = skillEntries({
      versions: [
        version("report", "1.0.0", "2026-10-01T00:00:00.000Z"),
        version("report", "2.0.0", "2026-10-02T00:00:00.000Z"),
        version("audit", "1.0.0", "2026-10-01T00:00:00.000Z", { reviewState: "proposed" }),
      ],
      activations: [{ scopeKey: "default", skillId: "report", activeVersion: "1.0.0", activatedBy: "operator", activatedAt: "x" }],
    });
    expect(entries.map((entry) => entry.skillId)).toEqual(["audit", "report"]);
    expect(entries[1]?.versions.map((entry) => entry.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(entries[1]).toMatchObject({ name: "report 1.0.0", active: "1.0.0" });
    expect(entries[0]).not.toHaveProperty("active");
  });

  it("shows each skill's uses and flags an active one unused for 60 days", () => {
    const activation = (skillId: string, activatedAt: string) => ({
      scopeKey: "default",
      skillId,
      activeVersion: "1.0.0",
      activatedBy: "operator",
      activatedAt,
    });
    const entries = skillEntries(
      {
        versions: [
          version("fresh", "1.0.0", "2026-01-01T00:00:00.000Z"),
          version("stale", "1.0.0", "2026-01-01T00:00:00.000Z"),
          version("idle", "1.0.0", "2026-01-01T00:00:00.000Z"),
        ],
        activations: [activation("fresh", "2026-01-01T00:00:00.000Z"), activation("stale", "2026-01-01T00:00:00.000Z")],
        usage: [
          { skillId: "fresh", uses: 3, lastUsedAt: "2026-10-20T00:00:00.000Z" },
          { skillId: "stale", uses: 1, lastUsedAt: "2026-05-01T00:00:00.000Z" },
        ],
      },
      Date.parse("2026-10-27T00:00:00.000Z"),
    );
    expect(entries.map((entry) => [entry.skillId, entry.uses, entry.unused])).toEqual([
      ["fresh", 3, false],
      ["idle", 0, false],
      ["stale", 1, true],
    ]);
    expect(entries[1]).not.toHaveProperty("lastUsedAt");
  });

  it("diffs a version against its parent line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(lineDiff("x\n".repeat(3_000), "y")).toBeUndefined();
  });

  it("marks another author's skill, and asserts the active version the page saw on an activation", async () => {
    expect(foreignProvenance("chat:task-1")).toBe(true);
    expect(foreignProvenance("archive:clawhub")).toBe(true);
    expect(foreignProvenance("team wiki")).toBe(false);
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (_command, payload) => {
        sent.push(payload);
        return { ok: true, result: {} } as never;
      },
    } as SettingsClient;
    await decideSkill(client, "default", { action: "activate", skillId: "report", version: "2.0.0" }, "1.0.0");
    await decideSkill(client, "default", { action: "approve", skillId: "report", version: "2.0.0" }, "1.0.0");
    expect(sent).toEqual([
      { action: "activate", skillId: "report", version: "2.0.0", workspaceId: "default", expectedCurrentVersion: "1.0.0" },
      { action: "approve", skillId: "report", version: "2.0.0", workspaceId: "default" },
    ]);
  });
});
