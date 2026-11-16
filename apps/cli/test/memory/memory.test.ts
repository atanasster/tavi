import { join } from "node:path";

import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { loadBetterSqlite3 } from "../../../../packages/runtime/src/persistence/sqlite-loader.js";
import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";

/**
 * `tavi memory`: the CLI surface for personal memory. Offline it takes exclusive ownership of the data directory, and
 * refuses while another process holds it without serving IPC; a live owner's
 * path is `memory-ipc.test.ts`.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-" });

afterAll(() => directories.cleanup());

describe("tavi memory", () => {
  it("keeps a preference from its key and value alone, the value as its text", async () => {
    const directory = directories.create();
    const remembered = capture();
    const argv = ["memory", "remember", "--kind", "preference", "--key", "units", "--value", "metric", "--data-dir", directory];
    expect(await main(argv, { io: remembered.io }), remembered.stderr()).toBe(EXIT.ok);
    const found = capture();
    expect(await main(["memory", "search", "metric", "--data-dir", directory], { io: found.io })).toBe(EXIT.ok);
    expect(found.stdout()).toContain(JSON.parse(remembered.stdout()).recordId);
  });

  it("corrects a preference's text along with its value", async () => {
    const directory = directories.create();
    const remembered = capture();
    const argv = ["memory", "remember", "--kind", "preference", "--key", "units", "--value", "metric", "--data-dir", directory];
    expect(await main(argv, { io: remembered.io }), remembered.stderr()).toBe(EXIT.ok);
    const { recordId } = JSON.parse(remembered.stdout()) as { recordId: string };
    const corrected = capture();
    const correct = ["memory", "correct", recordId, "--value", "imperial", "--data-dir", directory];
    expect(await main(correct, { io: corrected.io }), corrected.stderr()).toBe(EXIT.ok);
    const found = capture();
    expect(await main(["memory", "search", "imperial", "--data-dir", directory], { io: found.io })).toBe(EXIT.ok);
    expect(found.stdout()).toContain(recordId);
  });

  it("remembers a fact directly (propose + approve in one call) and shows it", async () => {
    const directory = directories.create();
    const remembered = capture();
    const code = await main(["memory", "remember", "--body", "Alice keeps a garden", "--data-dir", directory], { io: remembered.io });
    expect(code, remembered.stderr()).toBe(EXIT.ok);
    const record = JSON.parse(remembered.stdout()) as { recordId: string; status: string };
    expect(record.status).toBe("approved");

    const shown = capture();
    expect(await main(["memory", "show", record.recordId, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const fetched = JSON.parse(shown.stdout()) as { recordId: string; status: string };
    expect(fetched.recordId).toBe(record.recordId);
  });

  it("shows where an approved record's words came from when its chat had read untrusted content", async () => {
    const directory = directories.create();
    const remembered = capture();
    expect(await main(["memory", "remember", "--body", "Pays invoices on the 1st", "--data-dir", directory], { io: remembered.io })).toBe(
      EXIT.ok,
    );
    const record = JSON.parse(remembered.stdout()) as { recordId: string };
    // As `memory.propose` in a tainted chat stamps it, then kept: the keep endorses it, its provenance stays.
    const provenance = {
      integrity: "untrusted",
      sources: ["web"],
      refs: [{ source: "web", ref: "call-1", host: "billing.example.com", title: 'Pay "now"\nor else', at: "2026-10-13T00:00:00.000Z" }],
    };
    const live = new (loadBetterSqlite3())(join(directory, "tavi.sqlite"));
    live
      .prepare("UPDATE tavi_memory_revisions SET provenance_json = ? WHERE record_id = ?")
      .run(JSON.stringify(provenance), record.recordId);
    live.close();
    const shown = capture();
    expect(await main(["memory", "show", record.recordId, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain(
      "Proposed after this chat read a web page (billing.example.com) — the page calls itself “Pay 'now' or else”\n",
    );
    // In text the page's own words appear only in that line, never raw in the JSON above it.
    expect(shown.stdout()).not.toContain("provenance");
    const json = capture();
    expect(await main(["memory", "show", record.recordId, "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout())).toMatchObject({ recordId: record.recordId, status: "approved", provenance });
  });

  it("lists and searches what was remembered", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "Prefers dark roast coffee", "--data-dir", directory], { io: capture().io });

    const listed = capture();
    expect(await main(["memory", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const records = JSON.parse(listed.stdout()) as { status: string }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("approved");

    const found = capture();
    expect(await main(["memory", "search", "coffee", "--format", "json", "--data-dir", directory], { io: found.io })).toBe(EXIT.ok);
    const result = JSON.parse(found.stdout()) as { hits: { recordId: string }[] };
    expect(result.hits).toHaveLength(1);
  });

  it("answers partial matches, labelled, when no record holds every word of a search", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "The Lisbon flat has a balcony", "--data-dir", directory], { io: capture().io });
    await main(["memory", "remember", "--body", "Rent is due on the first", "--data-dir", directory], { io: capture().io });
    const exact = capture();
    expect(await main(["memory", "search", "Lisbon flat", "--format", "text", "--data-dir", directory], { io: exact.io })).toBe(EXIT.ok);
    expect(exact.stdout()).not.toContain("No exact match");
    const partial = capture();
    expect(await main(["memory", "search", "Lisbon flat rent", "--format", "text", "--data-dir", directory], { io: partial.io })).toBe(
      EXIT.ok,
    );
    const lines = partial.stdout().trim().split("\n");
    expect(lines[0]).toBe("No exact match; showing partial matches");
    expect(lines).toHaveLength(3);
    const json = capture();
    expect(await main(["memory", "search", "Lisbon flat rent", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(json.stdout())).toMatchObject({ match: "any" });
  });

  it("remembers a preference and corrects its value", async () => {
    const directory = directories.create();
    const remembered = capture();
    await main(
      [
        "memory",
        "remember",
        "--kind",
        "preference",
        "--key",
        "ui.theme",
        "--value",
        "dark",
        "--body",
        "dark mode",
        "--data-dir",
        directory,
      ],
      { io: remembered.io },
    );
    const record = JSON.parse(remembered.stdout()) as { recordId: string };

    const corrected = capture();
    expect(
      await main(["memory", "correct", record.recordId, "--body", "dark mode, always", "--value", "light", "--data-dir", directory], {
        io: corrected.io,
      }),
    ).toBe(EXIT.ok);
    const revised = JSON.parse(corrected.stdout()) as { currentRevisionId: string };
    expect(revised.currentRevisionId).toBeDefined();

    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite` });
    try {
      const revision = await store.asPort().repositories.memory.getRevision(revised.currentRevisionId);
      expect(revision?.preference?.value).toBe("light");
    } finally {
      store.close();
    }
  });

  it("remembers a fact with --topic and round-trips it through show", async () => {
    const directory = directories.create();
    const remembered = capture();
    await main(["memory", "remember", "--body", "Alice lives in Lisbon", "--topic", "alice.city", "--data-dir", directory], {
      io: remembered.io,
    });
    const record = JSON.parse(remembered.stdout()) as { recordId: string; topicKey?: string };
    expect(record.topicKey).toBe("alice.city");

    const shown = capture();
    expect(await main(["memory", "show", record.recordId, "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const fetched = JSON.parse(shown.stdout()) as { topicKey?: string };
    expect(fetched.topicKey).toBe("alice.city");
  });

  it("refuses --key/--value on remember unless --kind preference", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["memory", "remember", "--body", "x", "--value", "y", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.usage);
  });

  it("forgets a record, requiring --reason", async () => {
    const directory = directories.create();
    const remembered = capture();
    await main(["memory", "remember", "--body", "temporary note", "--data-dir", directory], { io: remembered.io });
    const record = JSON.parse(remembered.stdout()) as { recordId: string };

    const missingReason = capture();
    const missingCode = await main(["memory", "forget", record.recordId, "--data-dir", directory], { io: missingReason.io });
    expect(missingCode).toBe(EXIT.usage);

    const forgotten = capture();
    expect(
      await main(["memory", "forget", record.recordId, "--reason", "no longer needed", "--data-dir", directory], { io: forgotten.io }),
    ).toBe(EXIT.ok);

    const shown = capture();
    const shownCode = await main(["memory", "show", record.recordId, "--data-dir", directory], { io: shown.io });
    expect(shownCode).toBe(EXIT.unavailable);
  });

  it("exports everything the principal may see", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "exportable note", "--data-dir", directory], { io: capture().io });
    const exported = capture();
    expect(await main(["memory", "export", "--format", "json", "--data-dir", directory], { io: exported.io })).toBe(EXIT.ok);
    const bundle = JSON.parse(exported.stdout()) as { records: unknown[]; truncated: boolean };
    expect(bundle.records).toHaveLength(1);
    expect(bundle.truncated).toBe(false);
  });

  it("scopes memory by principal: a different --principal sees nothing", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "Alice's note", "--data-dir", directory], { io: capture().io });

    const bobsList = capture();
    expect(await main(["memory", "list", "--principal", "bob", "--format", "json", "--data-dir", directory], { io: bobsList.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(bobsList.stdout())).toEqual([]);
  });

  it("renders text output as one row per record/hit, marking sensitive records", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "plain note", "--data-dir", directory], { io: capture().io });
    await main(["memory", "remember", "--body", "secret note", "--sensitive", "--data-dir", directory], { io: capture().io });

    const listed = capture();
    expect(await main(["memory", "list", "--format", "text", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const lines = listed.stdout().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("(sensitive)"))).toBe(true);
    expect(lines.every((line) => line.includes("(sensitive)"))).toBe(false);

    const searched = capture();
    expect(await main(["memory", "search", "plain", "--format", "text", "--data-dir", directory], { io: searched.io })).toBe(EXIT.ok);
    expect(searched.stdout()).toContain("plain");

    const emptyList = capture();
    expect(
      await main(["memory", "list", "--principal", "nobody-here", "--format", "text", "--data-dir", directory], { io: emptyList.io }),
    ).toBe(EXIT.ok);
    expect(emptyList.stdout().trim()).toBe("(no records)");
  });

  it("defaults list/search/export to every authorized scope, not just personal", async () => {
    const directory = directories.create();
    await main(["memory", "remember", "--body", "personal note", "--data-dir", directory], { io: capture().io });
    await main(["memory", "remember", "--scope", "workspace", "--body", "workspace note", "--data-dir", directory], { io: capture().io });

    const listed = capture();
    expect(await main(["memory", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const records = JSON.parse(listed.stdout()) as { scope: { kind: string } }[];
    expect(records.map((r) => r.scope.kind).sort()).toEqual(["personal", "personal_workspace"]);

    const scoped = capture();
    expect(await main(["memory", "list", "--scope", "personal", "--format", "json", "--data-dir", directory], { io: scoped.io })).toBe(
      EXIT.ok,
    );
    expect((JSON.parse(scoped.stdout()) as unknown[]).length).toBe(1);

    const exported = capture();
    expect(await main(["memory", "export", "--format", "json", "--data-dir", directory], { io: exported.io })).toBe(EXIT.ok);
    const bundle = JSON.parse(exported.stdout()) as { records: unknown[] };
    expect(bundle.records).toHaveLength(2);
  });

  it("remembers into an agent's scope with --scope agent:<id>, and never into shared memory", async () => {
    const directory = directories.create();
    const remembered = capture();
    expect(
      await main(["memory", "remember", "--scope", "agent:chief", "--body", "agent note", "--format", "json", "--data-dir", directory], {
        io: remembered.io,
      }),
      remembered.stderr(),
    ).toBe(EXIT.ok);
    expect(JSON.parse(remembered.stdout())).toMatchObject({
      status: "approved",
      scope: { kind: "personal_agent", principalId: "operator", agentId: "chief", workspaceId: "default" },
    });
    await main(["memory", "remember", "--body", "personal note", "--data-dir", directory], { io: capture().io });

    const scoped = capture();
    expect(
      await main(["memory", "list", "--scope", "agent:chief", "--format", "json", "--data-dir", directory], { io: scoped.io }),
      scoped.stderr(),
    ).toBe(EXIT.ok);
    expect((JSON.parse(scoped.stdout()) as { body?: string; scope: { kind: string } }[]).map((record) => record.scope.kind)).toEqual([
      "personal_agent",
    ]);

    const shared = capture();
    expect(
      await main(["memory", "remember", "--scope", "shared", "--body", "for everyone", "--data-dir", directory], { io: shared.io }),
    ).toBe(EXIT.usage);
    expect(shared.stderr()).toContain("cannot write shared memory");
    expect(parseArgs(["memory", "list", "--scope", "shared"])).toMatchObject({ memory: { action: "list", scope: "shared" } });
    expect(() => parseArgs(["memory", "list", "--scope", "agent:"])).toThrow(/Unknown scope/);
  });

  it("refuses memory commands while an owner holds the data directory", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner" });
    try {
      const captured = capture();
      const code = await main(["memory", "list", "--data-dir", directory], { io: captured.io });
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toContain("already owns");
    } finally {
      owner.release();
    }
  });

  it("rejects malformed actions and missing arguments with usage output", async () => {
    const directory = directories.create();
    for (const argv of [
      ["memory", "frobnicate"],
      ["memory", "show"],
      ["memory", "search"],
      ["memory", "forget", "some-id"],
      ["memory", "list", "--scope", "nonsense"],
      ["memory", "list", "--unsupported-flag", "x"],
    ]) {
      const captured = capture();
      const code = await main([...argv, "--data-dir", directory], { io: captured.io });
      expect(code, `${argv.join(" ")} -> ${captured.stderr()}`).toBe(EXIT.usage);
    }
  });
});
