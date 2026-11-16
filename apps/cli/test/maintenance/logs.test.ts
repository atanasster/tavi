import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeLogSink, createLogSink, createRotatingFileSink, defaultLogPath, readLogTail } from "../../src/server/log-file.js";
import { EXIT, main } from "../../src/main.js";

/**
 * The daemon's log file.
 *
 * Everything the scheduler warned about went to stderr and nowhere else: under
 * launchd/systemd that is the platform's unified log, which no Tavi command can
 * read, and with the printed unit it is one append-only file nothing rotates.
 * These pin the rotation, the read-back, and the `logs` command.
 */

const directories = temporaryDirectories();

afterEach(() => {
  vi.useRealTimers();
  directories.cleanup();
});

describe("rotating log sink", () => {
  it("rotates by size and keeps the requested number of files", () => {
    const path = join(directories.create("tavi-logs-"), "tavi.log");
    // Small enough that three lines cross the threshold.
    const sink = createRotatingFileSink(path, 120, 2);
    for (let index = 0; index < 6; index += 1) sink(JSON.stringify({ at: `t${index}`, level: "info", message: `line ${index}` }));

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    // `keep: 2` means the current file plus two rotations, and the third
    // rotation drops the oldest rather than growing without bound.
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    // Nothing was lost before the oldest dropped file: the newest lines are in
    // the current one.
    expect(readFileSync(path, "utf8")).toContain("line 5");
  });

  it("reads the tail across a rotation boundary, oldest first", () => {
    const path = join(directories.create("tavi-logs-"), "tavi.log");
    // Each line is padded past 30 bytes so five of them certainly cross 120.
    const sink = createRotatingFileSink(path, 120, 3);
    for (let index = 0; index < 5; index += 1) sink(`line-${index}-${"x".repeat(30)}`);
    // The premise: this test is about a tail that straddles a rotation.
    expect(existsSync(`${path}.1`)).toBe(true);

    const tail = readLogTail(path, 4);
    expect(tail).toHaveLength(4);
    expect(tail.map((line) => line.split("-")[1])).toEqual(["1", "2", "3", "4"]);
  });

  it("does not rotate an empty file into existence", () => {
    const path = join(directories.create("tavi-logs-"), "tavi.log");
    createRotatingFileSink(path, 100, 3);
    expect(existsSync(path)).toBe(false);
  });

  it("holds one descriptor across lines, reopens it after a rotation and after close", () => {
    const path = join(directories.create("tavi-logs-"), "tavi.log");
    const sink = createRotatingFileSink(path, 60, 3);
    sink(`first-${"a".repeat(30)}`);
    sink(`second-${"b".repeat(30)}`);
    // The rotation closed the held descriptor before renaming: the second line
    // went to the fresh `<path>`, not into the renamed `<path>.1`.
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`first-${"a".repeat(30)}\n`);
    expect(readFileSync(path, "utf8")).toBe(`second-${"b".repeat(30)}\n`);

    sink.close();
    sink.close();
    sink("third");
    expect(readFileSync(path, "utf8")).toContain("third");
    sink.close();
  });

  it("follows a log file moved or deleted from outside instead of writing to it forever", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const directory = directories.create("tavi-logs-");
    const path = join(directory, "tavi.log");
    const moved = join(directory, "moved.log");
    const sink = createRotatingFileSink(path, 10_000, 3);
    sink("before-move");

    // An operator's logrotate moves the file away under the held descriptor.
    renameSync(path, moved);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    sink("after-move");
    expect(readFileSync(moved, "utf8")).toBe("before-move\n");
    expect(readFileSync(path, "utf8")).toBe("after-move\n");

    // And the same when it is deleted outright.
    rmSync(path);
    vi.setSystemTime(new Date("2026-01-01T00:00:04Z"));
    sink("after-delete");
    expect(readFileSync(path, "utf8")).toBe("after-delete\n");
    sink.close();
  });

  it("takes the byte count from the file when another writer rotated it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const path = join(directories.create("tavi-logs-"), "tavi.log");
    const first = createRotatingFileSink(path, 100, 3);
    first(`a-${"x".repeat(60)}`);
    const second = createRotatingFileSink(path, 100, 3);
    second(`b-${"y".repeat(60)}`);
    // `second` rotated `first`'s file to `<path>.1`; past the check interval,
    // `first` writes to the fresh `<path>`, not into the rotated file.
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    first("c");
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`a-${"x".repeat(60)}\n`);
    expect(readFileSync(path, "utf8")).toBe(`b-${"y".repeat(60)}\nc\n`);
    first.close();
    second.close();
  });

  it("never throws out of the logger, even when the file cannot be written", () => {
    // A directory where the log file should be: `appendFileSync` fails with
    // EISDIR. The sink must absorb it — a throw here propagates into whatever the
    // daemon was logging, which is how a full disk becomes a crash.
    const directory = directories.create("tavi-logs-broken-");
    mkdirSync(join(directory, "tavi.log"), { recursive: true, mode: 0o700 });
    const sink = createLogSink({ path: join(directory, "tavi.log") });
    expect(() => sink(JSON.stringify({ level: "info", message: "still alive" }))).not.toThrow();
  });

  it("lets go of its file when closed, so a reset can delete it, and opens a fresh one on the next line", () => {
    const directory = directories.create("tavi-logs-close-");
    const path = join(directory, "tavi.log");
    const sink = createLogSink({ path });
    sink("before");
    closeLogSink(sink);
    rmSync(path);
    sink("after");
    expect(readFileSync(path, "utf8")).toBe("after\n");
    sink.close();
    // A sink with no close holds nothing to release.
    expect(() => closeLogSink(() => undefined)).not.toThrow();
  });
});

describe("tavi logs", () => {
  it("reads the default log file and renders one line per entry", async () => {
    const directory = directories.create("tavi-logs-data-");
    const path = defaultLogPath(directory);
    mkdirSync(join(directory, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      [
        JSON.stringify({ at: "2026-04-05T04:00:00.000Z", level: "warn", message: "a schedule fire was missed" }),
        JSON.stringify({ at: "2026-04-05T04:00:01.000Z", level: "info", message: "schedule sweep fired runs" }),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const shown = capture();
    expect(await main(["logs", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain("warn\ta schedule fire was missed");
    expect(shown.stdout()).toContain("info\tschedule sweep fired runs");

    const limited = capture();
    expect(await main(["logs", "--tail", "1", "--format", "json", "--data-dir", directory], { io: limited.io })).toBe(EXIT.ok);
    const lines = JSON.parse(limited.stdout()) as string[];
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}").message).toBe("schedule sweep fired runs");
  });

  it("says which path it checked when there is no log yet, rather than looking empty", async () => {
    const directory = directories.create("tavi-logs-data-");
    const shown = capture();
    expect(await main(["logs", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain(`no log lines at ${defaultLogPath(directory)}`);
  });

  it("keeps a line it cannot parse instead of dropping it", async () => {
    const directory = directories.create("tavi-logs-data-");
    const path = defaultLogPath(directory);
    mkdirSync(join(directory, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(path, "a crash trace that is not JSON\n", { mode: 0o600 });
    const shown = capture();
    expect(await main(["logs", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain("a crash trace that is not JSON");
  });

  it("rejects a bad --tail as usage", async () => {
    const directory = directories.create("tavi-logs-data-");
    const refused = capture();
    expect(await main(["logs", "--tail", "0", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/--tail must be a positive integer/);
    const help = capture();
    expect(await main(["logs", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toMatch(/^tavi logs \[options\]/);
  });
});
