// @vitest-environment jsdom
import type { ClientResponse } from "@tavi/client/browser";
import { clip, errorMessage as messageOf, plural as counted } from "@tavi/contracts/util";
import { describe, expect, it } from "vitest";

import { manyPeople, personName, previewText } from "../../src/features/center/model.js";
import { groupByDay, relativeDay, todayIn, durationText } from "../../src/lib/time.js";
import { transitionSaid } from "../../src/features/center/reminder-model.js";
import { readChunks } from "../../src/lib/chunks.js";
import { firstLine, hostOf } from "../../src/lib/format.js";
import { ask, attempt, read, withList, type SettingsClient } from "../../src/lib/ipc.js";
import { readStored, readStoredJson, removeStored, writeStored, writeStoredJson } from "../../src/lib/storage.js";
import { loadTranscriptPage, readTaskRecord } from "../../src/features/chat/tasks-api.js";

/**
 * The canvas's shared helpers: the words for counts, cut text and failures;
 * optional storage; one owner request and its parsed, listed, chunked and
 * task-record forms; days grouped and said relative to today.
 */

const answering = (
  respond: (
    command: string,
    payload: Record<string, unknown>,
    options?: { readonly timeoutMs?: number },
  ) => ClientResponse | Promise<ClientResponse>,
): SettingsClient & { readonly calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    request: async (...args: Parameters<SettingsClient["request"]>) => {
      calls.push(args);
      return respond(args[0], args[1] as Record<string, unknown>, args[2]);
    },
  };
};

describe("format", () => {
  it("counts with a noun, regular or not", () => {
    expect([counted(0, "task"), counted(1, "task"), counted(2, "task")]).toEqual(["0 tasks", "1 task", "2 tasks"]);
    expect([counted(1, "other person", "other people"), counted(3, "other person", "other people")]).toEqual([
      "1 other person",
      "3 other people",
    ]);
  });

  it("clips with an ellipsis, and takes a trimmed first line", () => {
    expect([clip("abcdef", 4), clip("abcd", 4)]).toEqual(["abc…", "abcd"]);
    expect(firstLine("  hello  \nworld")).toBe("hello");
    expect(firstLine("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
    expect(firstLine("abcdef", 4)).toBe("abc…");
  });

  it("says a failure as its message, a URL as its host", () => {
    expect([messageOf(new Error("boom")), messageOf("plain"), messageOf(42)]).toEqual(["boom", "plain", "42"]);
    expect([hostOf("https://api.example.com:8443/v1"), hostOf("not a url"), hostOf("not a url", ""), hostOf(undefined)]).toEqual([
      "api.example.com:8443",
      "not a url",
      "",
      "",
    ]);
  });
});

describe("storage", () => {
  it("reads and writes through the storage handed in, as text or JSON", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
    expect(readStored("a", storage)).toBeUndefined();
    writeStored("a", "1", storage);
    writeStoredJson("b", { on: true }, storage);
    expect([readStored("a", storage), readStoredJson("b", storage)]).toEqual(["1", { on: true }]);
    kept.set("c", "{not json");
    expect(readStoredJson("c", storage)).toBeUndefined();
  });

  it("keeps nothing, and says nothing, when storage throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readStored("a", blocked)).toBeUndefined();
    expect(readStoredJson("a", blocked)).toBeUndefined();
    expect(() => writeStored("a", "1", blocked)).not.toThrow();
  });

  it("uses the browser's local or tab storage when none is handed in", () => {
    writeStored("tavi.test.local", "here");
    writeStoredJson("tavi.test.session", [1], "session");
    expect([
      window.localStorage.getItem("tavi.test.local"),
      readStoredJson("tavi.test.session", "session"),
      readStored("tavi.test.session"),
    ]).toEqual(["here", [1], undefined]);
  });
});

describe("owner requests", () => {
  it("asks by the given deadline, or the client's own, and keeps a refusal's code, details and words", async () => {
    const client = answering(() => ({ ok: false, error: { code: "CONFLICT", message: "settled", details: { settled: { by: "email" } } } }));
    expect(await ask(client, "approve", {}, { timeoutMs: null })).toEqual({
      ok: false,
      message: "settled",
      code: "CONFLICT",
      details: { settled: { by: "email" } },
    });
    await ask(client, "models", {});
    expect(client.calls.map((call) => call.length)).toEqual([2, 3]);
    expect(client.calls[1]?.[2]).toEqual({ timeoutMs: 30_000 });
    const silent = answering(() => ({ ok: false }));
    expect(await ask(silent, "routines", {}, { refused: "Routine action refused" })).toEqual({
      ok: false,
      message: "Routine action refused",
    });
    expect(await ask(silent, "routines", {})).toEqual({ ok: false, message: "routines was refused" });
  });

  it("turns a thrown request into words: the error's, or the caller's", async () => {
    const throwing = answering(() => {
      throw new Error("closed");
    });
    expect(await ask(throwing, "tasks", {})).toEqual({ ok: false, message: "closed" });
    expect(await ask(throwing, "channels", {}, { unreachable: "The service could not be reached." })).toEqual({
      ok: false,
      message: "The service could not be reached.",
    });
  });

  it("refuses an answer its schema cannot read, or one without its list", async () => {
    const schema = {
      safeParse: (value: unknown) => (typeof value === "number" ? { success: true as const, data: value } : { success: false as const }),
    };
    expect(
      await read(
        answering(() => ({ ok: true, result: 3 })),
        "center",
        {},
        schema,
      ),
    ).toEqual({ ok: true, value: 3 });
    expect(
      await read(
        answering(() => ({ ok: true, result: "x" })),
        "center",
        {},
        schema,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("center answer could not be read") });
    expect(withList({ ok: true, value: { rows: [] } }, "rows", "rows")).toEqual({ ok: true, value: { rows: [] } });
    expect(withList({ ok: true, value: {} }, "rows", "rows")).toMatchObject({
      ok: false,
      message: expect.stringContaining("The owner's rows could not be read"),
    });
  });

  it("reads a body chunk by chunk, refusing one that changed or runs too long", async () => {
    const body = [
      { offset: 0, hash: "h", nextOffset: 2, part: "ab" },
      { offset: 2, hash: "h", nextOffset: null, part: "cd" },
    ];
    const parts: string[] = [];
    const last = await readChunks(
      async (offset) => ({ ok: true, value: body.find((chunk) => chunk.offset === offset)! }),
      (chunk) => void parts.push(chunk.part),
      { changed: "changed" },
    );
    expect([last.ok, parts]).toEqual([true, ["ab", "cd"]]);
    const moved = await readChunks(
      async (offset) => ({ ok: true, value: { offset, hash: offset === 0 ? "a" : "b", nextOffset: offset + 1 } }),
      () => undefined,
      { changed: "changed" },
    );
    expect(moved).toEqual({ ok: false, message: "changed" });
    const endless = await readChunks(
      async (offset) => ({ ok: true, value: { offset, hash: "h", nextOffset: offset + 1 } }),
      () => undefined,
      { changed: "changed", tooLarge: "too large", maxChunks: 3 },
    );
    expect(endless).toEqual({ ok: false, message: "too large" });
  });

  it("reads a task's record found in the workspace, and a page of its history", async () => {
    const record = (body: unknown) => answering(() => ({ ok: true, result: body }));
    expect(await readTaskRecord(record({ task: { workspaceId: "w1", status: "completed" } }), "w1", "t1")).toMatchObject({
      ok: true,
      value: { task: { status: "completed" } },
    });
    expect(await readTaskRecord(record({ task: { workspaceId: "w2" } }), "w1", "t1")).toEqual({
      ok: false,
      message: "Chat not found in this workspace",
      code: "NOT_FOUND",
    });
    expect(await readTaskRecord(record({ found: false }), undefined, "t1", { notFound: "No record." })).toEqual({
      ok: false,
      message: "No record.",
      code: "NOT_FOUND",
    });
    const pages = answering(() => ({ ok: true, result: { entries: [] } }));
    expect(await loadTranscriptPage(pages, "w1", "t1", 7)).toEqual({ ok: true, value: { entries: [] } });
    expect(pages.calls[0]?.slice(0, 2)).toEqual(["tasks", { action: "transcript", taskId: "t1", workspaceId: "w1", before: 7 }]);
  });
});

describe("days", () => {
  it("says today and the day next to it toward the past or the future", () => {
    expect([
      relativeDay("2026-10-05", "2026-10-05", "past"),
      relativeDay("2026-10-04", "2026-10-05", "past"),
      relativeDay("2026-10-06", "2026-10-05", "past"),
    ]).toEqual(["today", "yesterday", undefined]);
    expect([relativeDay("2026-10-06", "2026-10-05", "future"), relativeDay("2026-10-04", "2026-10-05", "future")]).toEqual([
      "tomorrow",
      undefined,
    ]);
  });

  it("groups sorted items by the day they fall on in the zone", () => {
    const items = [{ at: "2026-10-05T23:30:00Z" }, { at: "2026-10-05T10:00:00Z" }, { at: "2026-10-04T10:00:00Z" }];
    expect(groupByDay(items, (item) => item.at, "UTC").map((day) => [day.date, day.items.length])).toEqual([
      ["2026-10-05", 2],
      ["2026-10-04", 1],
    ]);
    expect(groupByDay(items, (item) => item.at, "Europe/Berlin").map((day) => day.date)).toEqual([
      "2026-10-06",
      "2026-10-05",
      "2026-10-04",
    ]);
  });
});

describe("consolidated helpers", () => {
  it("says a time left rounded up, with seconds and days only where asked", () => {
    const minute = 60_000;
    expect([durationText(4.5 * minute), durationText(120 * minute), durationText(125 * minute), durationText(30 * 60 * minute)]).toEqual([
      "5 min",
      "2 h",
      "2 h 5 min",
      "30 h",
    ]);
    expect([
      durationText(45_000, { seconds: true }),
      durationText(45_000),
      durationText(26 * 60 * minute, { days: true }),
      durationText(24 * 60 * minute, { days: true }),
    ]).toEqual(["45 s", "1 min", "1 d 2 h", "1 d"]);
  });

  it("turns a throw into an outcome in its own words", async () => {
    expect(await attempt(async () => 3)).toEqual({ ok: true, value: 3 });
    expect(await attempt(async () => Promise.reject(new Error("gone")))).toEqual({ ok: false, message: "gone" });
    expect(
      await attempt(
        async () => Promise.reject(new Error("gone")),
        (message) => `Could not open: ${message}.`,
      ),
    ).toEqual({ ok: false, message: "Could not open: gone." });
  });

  it("forgets what is stored, and survives a store that throws", () => {
    const held = new Map([["k", "v"]]);
    removeStored("k", { removeItem: (key: string) => void held.delete(key) });
    expect(held.has("k")).toBe(false);
    expect(() =>
      removeStored("k", {
        removeItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });

  it("says today in the zone, and a person only once several are named", () => {
    const now = Date.parse("2026-10-04T23:30:00.000Z");
    expect([todayIn("UTC", now), todayIn("Asia/Tokyo", now), todayIn("UTC", new Date(now))]).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-04",
    ]);
    expect([manyPeople(undefined), manyPeople({ a: "Ann" }), manyPeople({ a: "Ann", b: "Bo" })]).toEqual([false, false, true]);
    expect([
      personName({ a: "Ann" }, "a"),
      personName({ a: "Ann", b: "Bo" }, "a"),
      personName({ a: "Ann", b: "Bo" }, "c"),
      personName({ a: "Ann", b: "Bo" }, undefined),
    ]).toEqual([undefined, "Ann", "c", undefined]);
  });

  it("names what a reminder became", () => {
    expect([transitionSaid("cancel"), transitionSaid("pause"), transitionSaid("resume", "Walk")]).toEqual([
      "Reminder cancelled.",
      "Reminder paused.",
      "Walk resumed.",
    ]);
  });
});

describe("row previews", () => {
  it("reads an answer's Markdown start as one plain line", () => {
    expect(previewText('```json\n{ "items": [] }\n```')).toBe('{ "items": [] }');
    expect(previewText('```json { "items": [] } ```')).toBe('{ "items": [] }');
    expect(previewText("## Done\n- **Moved** the `backup` to [the drive](https://x.test)\n> _quoted_")).toBe(
      "Done Moved the backup to the drive quoted",
    );
    expect(previewText("Renamed snake_case_name; 2*3*4 is 24")).toBe("Renamed snake_case_name; 2*3*4 is 24");
    expect(previewText("Edited `__init__.py` and `__main__`, **bold**")).toBe("Edited __init__.py and __main__, bold");
    expect(previewText("")).toBe("");
  });
});
