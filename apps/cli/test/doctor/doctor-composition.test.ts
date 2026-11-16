import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";

/** `tavi doctor` composed as a real invocation is: no suite opt-ins, unlike cli.test.ts. */
const directories = temporaryDirectories({ prefix: "tavi-doctor-" });
afterEach(() => directories.cleanup());

describe("tavi doctor", () => {
  it("reports composition status without a model connection", async () => {
    const captured = capture();
    const code = await main(["doctor", "--data-dir", directories.create()], { io: captured.io });
    const report = JSON.parse(captured.stdout()) as {
      admissionOpen: boolean;
      tools: { id: string }[];
      applicationTables: string[];
      saverTables: string[];
      saverSchema: { expected: number; recorded: string | null; matches: boolean; missingColumns: Record<string, string[]> };
      meta: Record<string, string>;
      integrity: { checked: boolean; ok: boolean | null; problems: string[] };
      disk: { dataDirectory: string; freeBytes: number | null; belowFloor: boolean | null };
      migrations: { applied: string[]; latest: string | null; unknown: string[] };
      plugins: { id: string; phase: string }[];
    };
    expect(code).toBe(EXIT.ok);
    // The fixture tool is not on a real deployment's tool surface (cli.test.ts proves the suites' opt-in works).
    expect(report.tools.map((tool) => tool.id)).not.toContain("fixture.echo");
    expect(report.tools.map((tool) => tool.id)).toContain("memory.search");
    expect(report.applicationTables).toContain("tavi_tasks");
    // Composition calls the saver's `setup()`, so both tables exist from
    // the moment the directory does — `doctor` used to report `[]` here, which
    // meant a directory that had never run a graph had no `checkpoints` at all,
    // and a future version's schema change would have been invisible until a run
    // failed inside it.
    expect(report.saverTables).toEqual(["checkpoints", "writes"]);
    expect(report.saverSchema).toEqual({ expected: 1, recorded: "1", matches: true, missingColumns: {} });
    expect(report.meta["saver.schema_version"]).toBe("1");
    // Integrity and the migration ledger: doctor runs SQLite's quick check (`--deep`
    // for the full one) and reports the ledger against this build.
    expect(report.integrity).toEqual({ checked: true, mode: "quick", ok: true, problems: [] });
    // Disk headroom: the check has to happen before the disk is full, because the alert
    // about a full disk is itself a database write.
    expect(report.disk.belowFloor).toBe(false);
    expect(report.disk.freeBytes === null || report.disk.freeBytes > 0).toBe(true);
    expect(report.migrations.unknown).toEqual([]);
    expect(report.migrations.applied).toContain("0001_baseline");
    // Without a model connection the workflow plugin is simply absent.
    expect(report.plugins.map((plugin) => plugin.id)).not.toContain("tavi.workflow");
    expect(report.admissionOpen).toBe(true);
  });

  it("shows whether the seeded web_search allow rule is still in force", async () => {
    const directory = directories.create();
    const webSearch = async () => {
      const captured = capture();
      expect(await main(["doctor", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
      return (JSON.parse(captured.stdout()) as { webSearch: { allowRule: { ruleId: string; present: boolean }; line: string } }).webSearch;
    };
    const seeded = await webSearch();
    expect(seeded.allowRule).toEqual({ ruleId: "seeded-web-search", present: true });
    expect(seeded.line).toMatch(/without asking/);
    expect(await main(["permissions", "rm", "seeded-web-search", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    // Removed once, it is never seeded again.
    const removed = await webSearch();
    expect(removed.allowRule.present).toBe(false);
    expect(removed.line).toMatch(/ask each time/);
  });
});
