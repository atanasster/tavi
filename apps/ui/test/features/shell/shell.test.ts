import { initialRunState, type RunState } from "@tavi/client/browser";
import { afterEach, describe, expect, it } from "vitest";

import {
  needsCount,
  runStatus,
  sessionsOf,
  sessionStats,
  sessionToolGroups,
  selectedSession,
  shellState,
  directoryRows,
  type SessionStatus,
  headerStatusLabel,
} from "../../../src/features/shell/shell.js";
import { formatElapsed } from "../../../src/lib/time.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { rowTitle } from "../../../src/features/center/model.js";
import type { CanvasRun } from "../../../src/features/chat/store/types.js";

/**
 * The shell's pure parts: one status vocabulary, the
 * sessions the sidebar lists, the groups it orders them by, and the figures
 * the strip may honestly show.
 */

const run = (id: string, extra: Partial<CanvasRun> = {}, state: Partial<RunState> = {}): CanvasRun => ({
  id,
  prompt: `prompt ${id}`,
  run: { ...initialRunState(), ...state },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

describe("the status vocabulary", () => {
  it("maps every run status onto the A2A set, with `unknown` kept as itself", () => {
    const cases: readonly [Partial<RunState>, SessionStatus][] = [
      [{ status: "idle" }, "submitted"],
      [{ status: "running" }, "working"],
      [{ status: "awaiting_approval" }, "input-required"],
      [{ status: "waiting" }, "input-required"],
      [{ status: "review_required" }, "input-required"],
      [{ status: "completed" }, "completed"],
      [{ status: "failed", outcome: { kind: "failed", errorCode: "PROVIDER", message: "down" } }, "failed"],
      [{ status: "failed", outcome: { kind: "failed", errorCode: "CANCELLED", message: "stopped" } }, "canceled"],
      [{ status: "stopped", outcome: { kind: "stopped", message: "You stopped this." } }, "stopped"],
      [{ status: "failed", outcome: { kind: "failed", errorCode: "ABORTED", message: "the owner is shutting down" } }, "failed"],
      [{ status: "unknown" }, "unknown"],
    ];
    for (const [state, expected] of cases) expect(runStatus(run("r", {}, state)), `run status ${String(state.status)}`).toBe(expected);
  });

  it("calls an entry the page could not follow failed, whatever its stream last said", () => {
    expect(runStatus(run("r", { error: "the stream lost its place" }, { status: "running" }))).toBe("failed");
  });
});

describe("the sessions a sidebar lists", () => {
  it("folds a task's turns into one session, titled by its first prompt and badged by its latest turn", () => {
    const first = run("ui-1", {}, { taskId: "task-1", status: "completed" });
    const second = run("ui-2", { prompt: "and then?", continues: "task-1" }, { taskId: "task-1", status: "awaiting_approval" });
    const sessions = sessionsOf([first, second]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe("task-1");
    expect(sessions[0]?.taskId).toBe("task-1");
    expect(sessions[0]?.title).toBe("prompt ui-1");
    expect(sessions[0]?.status).toBe("input-required");
    expect(sessions[0]?.runs).toHaveLength(2);
  });

  it("hands a session the same turns array while its turns are the same objects, and a new one once one changes", () => {
    const first = run("ui-1", {}, { taskId: "task-1", status: "completed" });
    const second = run("ui-2", { continues: "task-1" }, { taskId: "task-1", status: "running" });
    const other = run("ui-3", {}, { taskId: "task-2", status: "running" });
    const kept = sessionsOf([first, second, other])[0]?.runs;
    // Another chat's turn moved: this chat's turns are untouched.
    const moved = { ...other, prompt: "changed" };
    expect(sessionsOf([first, second, moved])[0]?.runs).toBe(kept);
    // One of its own turns moved: a new array, with the new turn in it.
    const grown = { ...second, run: { ...second.run, status: "completed" as const } };
    const changed = sessionsOf([first, grown, moved])[0]?.runs;
    expect(changed).not.toBe(kept);
    expect(changed).toEqual([first, grown]);
  });

  it("keeps a prompt whose run has no task yet as a session of its own", () => {
    const sessions = sessionsOf([run("ui-1"), run("ui-2", {}, { taskId: "task-2" })]);
    expect(sessions.map((session) => session.key)).toEqual(["ui-1", "task-2"]);
    expect(sessions[0]?.taskId).toBeUndefined();
  });

  it("titles a session by its first line, clamped, and names one without a prompt plainly, never by an id", () => {
    expect(sessionsOf([run("ui-1", { prompt: "  the first line  \nthe second" })])[0]?.title).toBe("the first line");
    expect(sessionsOf([run("ui-1", { prompt: "x".repeat(200) })])[0]?.title).toHaveLength(80);
    const replayed = sessionsOf([run("ui-1", { prompt: "", restored: true }, { taskId: "task-9" })]);
    expect(replayed[0]?.title).toBe("Earlier chat");
    // A promptless turn of a task the page is following, and one with neither.
    expect(sessionsOf([run("ui-1", { prompt: "" }, { taskId: "task-9" })])[0]?.title).toBe("Untitled chat");
    expect(sessionsOf([run("ui-1", { prompt: "   " })])[0]?.title).toBe("Untitled chat");
  });

  it("counts only what needs the reader", () => {
    const sessions = sessionsOf([
      run("ui-1", {}, { taskId: "a", status: "waiting" }),
      run("ui-2", {}, { taskId: "b", status: "running" }),
      run("ui-3", {}, { taskId: "c", status: "completed" }),
      run("ui-4", {}, { taskId: "d", status: "awaiting_approval" }),
    ]);
    expect(needsCount(sessions)).toBe(2);
  });

  it("falls back to the newest session when the selection is one the page no longer holds", () => {
    const sessions = sessionsOf([run("ui-1", {}, { taskId: "a" }), run("ui-2", {}, { taskId: "b" })]);
    expect(selectedSession(sessions, "a")?.key).toBe("a");
    expect(selectedSession(sessions, "gone")?.key).toBe("b");
    expect(selectedSession(sessions, undefined)?.key).toBe("b");
    expect(selectedSession([], "a")).toBeUndefined();
  });
});

describe("the footer strip's figures", () => {
  it("measures working time from the owner's own stamps, summed per turn: the gap between turns is not in it", () => {
    const session = sessionsOf([
      run("ui-1", { startedAt: "2026-09-20T12:00:00.000Z", lastAt: "2026-09-20T12:00:30.000Z" }, { taskId: "task-1" }),
      // The next morning: a night between turns is not work.
      run("ui-2", { startedAt: "2026-09-21T09:00:00.000Z", lastAt: "2026-09-21T09:01:00.000Z" }, { taskId: "task-1" }),
    ])[0];
    expect(session).toBeDefined();
    expect(session === undefined ? undefined : sessionStats(session).elapsedMs).toBe(90_000);
  });

  it("prefers a turn's measured working time to its span, which may hold a wait on a person", () => {
    const session = sessionsOf([
      run("ui-1", { startedAt: "2026-09-20T12:00:00.000Z", lastAt: "2026-09-20T23:00:00.000Z", activeMs: 45_000 }, { taskId: "task-1" }),
    ])[0];
    expect(session === undefined ? undefined : sessionStats(session).elapsedMs).toBe(45_000);
  });

  it("says nothing it cannot measure: no stamps, no elapsed", () => {
    const session = sessionsOf([run("ui-1", {}, { taskId: "task-1" })])[0];
    expect(session === undefined ? "missing" : sessionStats(session).elapsedMs).toBeUndefined();
  });

  it("counts every tool call the session made, folded out of the transcript window or not", () => {
    const card = (callId: string) => ({
      kind: "tool" as const,
      key: callId,
      attemptId: "a",
      callId,
      toolName: "mail.send",
      status: "completed" as const,
    });
    const session = sessionsOf([
      run("ui-1", {}, { taskId: "task-1", transcript: [card("c1"), { kind: "text", key: "t", attemptId: "a", blockId: "b", text: "hi" }] }),
      run("ui-2", {}, { taskId: "task-1", transcript: [card("c2"), card("c3")] }),
    ])[0];
    expect(session === undefined ? -1 : sessionStats(session).tools).toBe(3);
  });

  it("reconciles a whole-task snapshot with cached turns without merging reused call ids", () => {
    const card = (attemptId: string, key: string, status: "completed" | "running" = "completed") => ({
      kind: "tool" as const,
      key,
      attemptId,
      callId: "reused",
      toolName: "web_search",
      status,
    });
    const history = { partial: false, tools: [card("a", "a:reused"), card("b", "b:reused")] };
    const session = sessionsOf([
      run("ui-1", {}, { taskId: "task-1", transcript: [card("a", "tool:a:reused")] }),
      run("ui-2", { recordedHistory: history }, { taskId: "task-1", transcript: [card("b", "tool:b:reused", "running")] }),
    ])[0];
    if (session === undefined) throw new Error("Missing session");
    expect(sessionStats(session).tools).toBe(2);
    expect(sessionToolGroups(session).flatMap((group) => group.cards)).toMatchObject([
      { attemptId: "a", status: "completed" },
      { attemptId: "b", status: "completed" },
    ]);
    const repeated = sessionsOf([
      run(
        "ui-3",
        { recordedHistory: history },
        { taskId: "task-1", transcript: [card("b", "tool:b:reused"), card("b", "tool:b:reused@epoch:9")] },
      ),
    ])[0];
    if (repeated === undefined) throw new Error("Missing repeated session");
    expect(sessionStats(repeated).tools).toBe(3);
  });

  it("formats elapsed short enough for a strip and exact enough to act on", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(1_400)).toBe("1.4s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
    // The three thresholds, pinned: a tenth of a second up to 10s, whole
    // seconds up to a minute, minutes up to an hour.
    expect(formatElapsed(9_999)).toBe("10.0s");
    expect(formatElapsed(10_000)).toBe("10s");
    expect(formatElapsed(59_999)).toBe("60s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
    expect(formatElapsed(3_600_000)).toBe("1h 00m");
  });
});

describe("the shell's derived state", () => {
  it("is computed once per repaint, and every zone reads the same session from it", () => {
    const shell = shellState(
      {
        connection: "ready",
        runs: [run("ui-1", {}, { taskId: "a", status: "completed" }), run("ui-2", {}, { taskId: "b", status: "waiting" })],
      },
      undefined,
    );
    expect(shell.sessions.map((session) => session.key)).toEqual(["a", "b"]);
    expect(shell.needs).toBe(1);
    // The newest by default.
    expect(shell.current?.key).toBe("b");
    expect(shellState({ connection: "ready", runs: [] }, undefined).current).toBeUndefined();
  });
});

it("names a chat as the owner does, so its title does not flip once the panel reads it", () => {
  const runs = [
    run("ui-1", { prompt: "Find the best flights" }, { taskId: "home-1", status: "completed" }),
    run("ui-2", { prompt: "", restored: true }, { taskId: "t-2", status: "waiting" }),
  ];
  // The page's own Home is "Home" before any list is read.
  expect(shellState({ connection: "ready", runs, home: "home-1" }, "home-1").current?.title).toBe("Home");
  // A listed title wins — a rename of Home, or a chat's generated title over "Earlier in t-2".
  const row = (taskId: string, title: string) => ({ taskId, title, counts: {}, needs: [] }) as never;
  const directory = { rows: [row("home-1", "Trips"), row("t-2", "Flights to Tampa")], needs: [], loading: false, needsTruncated: false };
  const named = shellState({ connection: "ready", runs, home: "home-1", directory }, undefined);
  expect(named.sessions.map((session) => session.title)).toEqual(["Trips", "Flights to Tampa"]);
  // Nothing known: the first prompt, as before.
  expect(shellState({ connection: "ready", runs }, "home-1").current?.title).toBe("Find the best flights");
});

it("counts the scoped directory inbox rather than unscoped loaded sessions", () => {
  expect(
    shellState(
      {
        connection: "ready",
        runs: [run("foreign", {}, { status: "waiting" })],
        directory: { rows: [], needs: [], loading: false, needsTruncated: false },
      },
      undefined,
    ).needs,
  ).toBe(0);
});

it("reconciles workspace asks with newer live events without clearing unknown tasks", () => {
  const row = {
    taskId: "t",
    workspaceId: "default",
    status: "input-required" as const,
    origin: "ipc" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    needs: ["question" as const],
    counts: { admissions: 1, tools: 0 },
  };
  const directory = { rows: [row], needs: [row], loading: false, needsTruncated: false };
  const completed = run(
    "r",
    { lastAt: "2026-01-01T00:01:00Z", needsRevision: "new-event" },
    { taskId: "t", workspaceId: "default", status: "completed" },
  );
  expect(shellState({ connection: "ready", runs: [completed], directory }, undefined).needs).toBe(0);
  expect(directoryRows({ connection: "ready", runs: [completed], directory }, "default")[0]).toMatchObject({
    status: "completed",
    needs: [],
  });
  expect(
    shellState({ connection: "ready", runs: [{ ...completed, run: { ...completed.run, status: "unknown" } }], directory }, undefined).needs,
  ).toBe(1);
  const newerAsk = run(
    "new",
    { lastAt: "2026-01-01T00:01:00Z", needsRevision: "new-event" },
    {
      taskId: "new",
      workspaceId: "default",
      status: "waiting",
      waiting: { on: "reply", question: "Which?", deadlineAt: "2099-01-01T00:00:00Z" },
    },
  );
  expect(shellState({ connection: "ready", runs: [newerAsk], directory }, undefined).needs).toBe(2);
  expect(
    shellState({ connection: "ready", runs: [{ ...newerAsk, run: { ...newerAsk.run, workspaceId: "other" } }], directory }, undefined)
      .needs,
  ).toBe(1);
});

it("does not erase a freshly polled artifact review with a previously observed completion", () => {
  const row = {
    taskId: "t",
    workspaceId: "default",
    status: "completed" as const,
    origin: "ipc" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    needs: ["review" as const],
    counts: { admissions: 1, tools: 0 },
  };
  const completed = run(
    "r",
    { lastAt: "2026-01-01T00:01:00Z", needsRevision: "observed" },
    { taskId: "t", workspaceId: "default", status: "completed" },
  );
  const state = {
    connection: "ready" as const,
    runs: [completed],
    directory: { rows: [row], needs: [row], observedNeeds: { t: "observed" }, loading: false, needsTruncated: false },
  };
  expect(directoryRows(state, "default")[0]?.needs).toEqual(["review"]);
  expect(shellState(state, undefined).needs).toBe(1);
});

it("retains descendant asks when a newer parent completion clears its own ask", () => {
  const row = {
    taskId: "t",
    workspaceId: "default",
    status: "completed" as const,
    origin: "ipc" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    needs: ["review" as const],
    descendantNeeds: ["review" as const],
    counts: { admissions: 1, tools: 0 },
  };
  const completed = run("r", { needsRevision: "new" }, { taskId: "t", workspaceId: "default", status: "completed" });
  const state = {
    connection: "ready" as const,
    runs: [completed],
    directory: { rows: [row], needs: [row], loading: false, needsTruncated: false },
  };
  expect(directoryRows(state, "default")[0]?.needs).toEqual(["review"]);
  expect(shellState(state, undefined).needs).toBe(1);
});

it("says a Home whose latest turn ended is idle, never completed or failed", () => {
  const row = {
    taskId: "home",
    workspaceId: "default",
    status: "working" as const,
    origin: "web" as const,
    chatKind: "home" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    needs: [],
    counts: { admissions: 1, tools: 0 },
  };
  const directory = { rows: [row], needs: [], loading: false, needsTruncated: false };
  for (const status of ["completed", "failed"] as const) {
    const ended = run(
      "r",
      { lastAt: "2026-01-01T00:01:00Z", needsRevision: "new-event" },
      { taskId: "home", workspaceId: "default", status },
    );
    expect(directoryRows({ connection: "ready", runs: [ended], directory }, "default")[0]?.status).toBe("idle");
    // Any other chat says how it ended.
    expect(
      directoryRows(
        { connection: "ready", runs: [ended], directory: { ...directory, rows: [{ ...row, chatKind: undefined }] } } as never,
        "default",
      )[0]?.status,
    ).toBe(status);
  }
});

describe("headerStatusLabel", () => {
  it("says Home is ready between turns, as the chats list does, and any other chat as it ended", () => {
    expect(headerStatusLabel("completed", true)).toBe("ready");
    expect(headerStatusLabel("failed", true)).toBe("ready");
    expect(headerStatusLabel("canceled", true)).toBe("ready");
    expect(headerStatusLabel("canceled", false)).toBe("cancelled");
    expect(headerStatusLabel("stopped", true)).toBe("ready");
    expect(headerStatusLabel("stopped", false)).toBe("stopped");
    expect(headerStatusLabel("working", true)).toBe("working");
    expect(headerStatusLabel("completed", false)).toBe("completed");
  });
});

it("shows a chat working once its approval was given, though a list polled before the owner recorded it says it needs you", () => {
  const row = {
    taskId: "t",
    workspaceId: "default",
    status: "input-required" as const,
    origin: "ipc" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    needs: ["approval" as const],
    counts: { admissions: 1, tools: 0 },
  };
  // The list was polled after the decision's event (its revision observed), yet answered the row as it was before it.
  const working = run(
    "r",
    { lastAt: "2026-01-01T00:00:20Z", needsRevision: "observed" },
    { taskId: "t", workspaceId: "default", status: "running" },
  );
  const state = {
    connection: "ready" as const,
    runs: [working],
    directory: { rows: [row], needs: [row], observedNeeds: { t: "observed" }, loading: false, needsTruncated: false },
  };
  expect(directoryRows(state, "default")[0]).toMatchObject({ status: "working", needs: [] });
  expect(shellState(state, undefined).needs).toBe(0);
});

describe("Home's stored title", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("is said in the page's language, a rename as the reader wrote it", async () => {
    const runs = [run("ui-1", { prompt: "Find the best flights" }, { taskId: "home-1", status: "completed" })];
    const home = { taskId: "home-1", title: "Home", titleSource: "home", counts: {}, needs: [] } as never;
    const directory = { rows: [home], needs: [], loading: false, needsTruncated: false };
    expect(shellState({ connection: "ready", runs, home: "home-1", directory }, undefined).current?.title).toBe("Home");
    expect(rowTitle(home)).toBe("Home");
    await setLocale("bg");
    expect(shellState({ connection: "ready", runs, home: "home-1", directory }, undefined).current?.title).toBe("Начало");
    expect(rowTitle(home)).toBe("Начало");
    // The reader called it Home themselves: their word, as written.
    const renamed = { taskId: "home-1", title: "Home", titleSource: "reader", counts: {}, needs: [] } as never;
    expect(rowTitle(renamed)).toBe("Home");
    expect(
      shellState({ connection: "ready", runs, home: "home-1", directory: { ...directory, rows: [renamed] } }, undefined).current?.title,
    ).toBe("Home");
  });
});
