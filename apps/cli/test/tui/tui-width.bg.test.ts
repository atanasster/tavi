import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_PROTOCOL_VERSION, ClientEventSchema, type ClientEvent } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import type { DoctorDocument } from "../../src/features/doctor/reports.js";
import { doctorSummary } from "../../src/features/doctor/client.js";
import { heartbeatStatusText } from "../../src/features/heartbeat/text.js";
import { stepLine } from "../../src/features/onboard/flow.js";
import { fittedRow, wrappedLines } from "../../src/shared/terminal-text.js";
import { pageIn } from "../../src/shared/terminal-words.js";
import { commandHelp } from "../../src/tui/commands.js";
import { FORMS, enterField, openForm, type FormId, type FormStep } from "../../src/tui/forms.js";
import { agentsPane, approvalsPane, chatsPane, credentialsPane, needsPane, pluginsPane, schedulesPane } from "../../src/tui/panes.js";
import { ChatStore } from "../../src/tui/store.js";

/**
 * `tavi chat` and the text commands in a Bulgarian workspace, at 80 and 120
 * columns (Tier 5's TUI walk, kept): no line wider than the terminal, the
 * status row never cut inside a word and whole wherever its words can fit,
 * columns that line up, and English as it always was.
 */

const bg = coreIn("bg");
const WIDTHS = [80, 120] as const;
const AT = "2026-09-19T11:55:00.000Z";
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/client/test/fixtures");
const fixture = (name: string): ClientEvent[] =>
  readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ClientEventSchema.parse(JSON.parse(line)));

let sequence = 10_000;
const event = (kind: string, fields: Record<string, unknown>, attemptId = "attempt-1"): ClientEvent =>
  ClientEventSchema.parse({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "epoch-0",
    sequence: sequence++,
    runId: "task-0",
    attemptId,
    at: "2026-01-01T00:00:00.000Z",
    kind,
    ...fields,
  });

const TRUSTED = { integrity: "trusted", sources: [], principals: [], confidentiality: "public", refs: [] };
const UNTRUSTED = {
  integrity: "untrusted",
  sources: ["web", "email"],
  principals: [],
  confidentiality: "public",
  refs: [
    { source: "web", ref: "call-1", host: "news.example", title: "Daily", at: AT },
    { source: "email", ref: "m1", host: "x.example", at: AT },
  ],
};

/** A store `columns` wide that flushes only when asked. */
const storeAt = (columns: number, t: CoreT, prompting = true): ChatStore =>
  new ChatStore({ columns: () => columns, rows: () => 30, reservedRows: 2, schedule: () => () => undefined, prompting, words: t });

const statusOf = (store: ChatStore): string => {
  store.flush();
  return store.view().status;
};

/** A round of one ungrouped call that every scope may answer. */
function plainRound(store: ChatStore): void {
  store.push(event("run.started", { threadId: "thread-0", workspaceId: "default" }, "attempt-0"));
  store.push(
    event("approval.required", {
      callId: "call-x",
      toolName: "fs.write",
      summary: "Write notes.md",
      input: { path: "notes.md" },
      steps: 3,
      approvalId: "approval:6:task-0:3:6:call-x",
      effect: "mutating",
      risk: { level: "high", reasons: [], tainted: false, label: TRUSTED },
      display: { title: "Write notes.md" },
      allowedScopes: ["once", "session", "always"],
    }),
  );
  store.roundCalls(3, new Set(["call-x"]));
}

/** A browser round of three calls, each on a host of its own: its group's name grows with every host. */
function browserRound(store: ChatStore): void {
  store.push(event("run.started", { threadId: "thread-0", workspaceId: "default" }, "attempt-0"));
  const hosts = ["news.example.com", "mail.example.org", "docs.example.net"];
  for (const [index, host] of hosts.entries())
    store.push(
      event("approval.required", {
        callId: `call-${String(index)}`,
        toolName: "browser.navigate",
        summary: `Open ${host}`,
        input: { url: `https://${host}/` },
        steps: 2,
        approvalId: `approval:6:task-0:2:6:call-${String(index)}`,
        effect: "external",
        risk: { level: "low", reasons: [], tainted: false, label: TRUSTED },
        display: { title: `Open ${host}`, host },
        allowedScopes: ["once", "session", "always"],
        scopeGroup: "browser.*",
      }),
    );
  store.roundCalls(2, new Set(["call-0", "call-1", "call-2"]));
}

/** What each key of a Bulgarian round row may say right after its letter: its grant, whole. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  д: ["одобри", "за чата: ", "за чата"],
  ч: ["за чата", "до утре"],
  в: ["правило"],
  н: ["откажи"],
  Н: ["откажи с причина"],
};

/** The keys a round row names, each with whether its grant follows it whole. */
function keysOf(row: string): { readonly key: string; readonly whole: boolean }[] {
  return [...row.matchAll(/(?:^|[,:] |⏸ )([дчвнН]) — /gu)].map((match) => {
    const key = match[1] ?? "";
    const at = (match.index ?? 0) + match[0].length;
    // A grant is whole when its words end where the key does: at the next key, the row's end, or the name it allows.
    const whole = (GRANTS[key] ?? []).some(
      (grant) => row.startsWith(grant, at) && /^(?:$|, [дчвнН] — |\S)/u.test(row.slice(at + grant.length).replace(/^: /u, "x")),
    );
    return { key, whole };
  });
}

/** Every status row the walk covers, at `columns`, as `[state, row]`. */
function statusRows(columns: number, t: CoreT): (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [];
  const idle = storeAt(columns, t);
  rows.push(["idle", statusOf(idle)]);
  idle.next("home");
  rows.push(["idle, Home", statusOf(idle)]);

  const grouped = storeAt(columns, t);
  grouped.begin();
  for (const recorded of fixture("two-call-round").slice(0, 4)) grouped.push(recorded);
  grouped.roundCalls(1, new Set(["call-a", "call-b"]));
  rows.push(["round, the browser", statusOf(grouped)]);
  grouped.deciding(1);
  rows.push(["deciding", statusOf(grouped)]);

  for (const home of [false, true]) {
    const round = storeAt(columns, t);
    round.begin();
    if (home) round.setHome("task-0");
    plainRound(round);
    rows.push([`round${home ? ", Home" : ""}`, statusOf(round)]);
  }

  const reviewed = fixture("review-required");
  const review = storeAt(columns, t);
  review.begin();
  for (const recorded of reviewed.slice(0, reviewed.findIndex((recorded) => recorded.kind === "task.review_required") + 1))
    review.push(recorded);
  rows.push(["review", statusOf(review)]);

  const asked = fixture("waiting-question");
  const waiting = storeAt(columns, t);
  waiting.begin();
  for (const recorded of asked.slice(0, asked.findIndex((recorded) => recorded.kind === "task.waiting") + 1)) waiting.push(recorded);
  rows.push(["waiting", statusOf(waiting)]);

  for (const next of ["new", "continue", "home", "side"] as const)
    for (const home of [false, true]) {
      const done = storeAt(columns, t);
      done.begin();
      for (const recorded of reviewed) done.push(recorded);
      done.end();
      done.next(next, home);
      rows.push([`done, next ${next}${home ? ", Home" : ""}`, statusOf(done)]);
    }

  const running = storeAt(columns, t);
  running.begin();
  running.push(event("run.started", { threadId: "thread-0", workspaceId: "default" }, "attempt-0"));
  rows.push(["running", statusOf(running)]);
  running.markPrivate("task-0");
  running.setTaint("task-0", UNTRUSTED as never);
  rows.push(["running, private, read untrusted", statusOf(running)]);

  for (const id of Object.keys(FORMS) as FormId[]) {
    const form = storeAt(columns, t);
    let step: FormStep | ReturnType<typeof enterField> = openForm(id, [], t);
    while (step.kind === "ask") {
      form.form(step.state);
      rows.push([`form ${id}, field ${String(step.state.index + 1)}`, statusOf(form)]);
      const field = FORMS[id].fields[step.state.index];
      step = enterField(step.state, ANSWERS[field?.key ?? ""] ?? "x", t);
    }
  }
  return rows;
}

const ANSWERS: Readonly<Record<string, string>> = {
  reference: "openai",
  value: "secret",
  connectionId: "openai",
  baseUrl: "https://api.example/v1",
  credentialRef: "openai",
  model: "gpt-5",
  role: "main",
};

/** Whether `shown` is `whole` cut where a part, a clause or a word ends, and marked with `…`. */
function cutAtABoundary(shown: string, whole: string): boolean {
  if (shown === whole) return true;
  if (!shown.endsWith("…")) return false;
  const kept = shown.slice(0, -1);
  // A row with marks keeps them whole: its own words are cut before them.
  const parts = kept.split("… · ");
  const head = parts[0] ?? "";
  const rest = whole.slice(head.length);
  return whole.startsWith(head) && /^(?: · |; |, | — | )/.test(rest);
}

describe("a Bulgarian round's row", () => {
  for (const columns of [80, 120, 150]) {
    it(`names every key with its whole grant, however long its hosts, at ${String(columns)} columns`, () => {
      const store = storeAt(columns, bg);
      store.begin();
      browserRound(store);
      const row = statusOf(store);
      expect(stringWidth(row)).toBeLessThanOrEqual(columns);
      const keys = keysOf(row);
      expect(keys.map((key) => key.key)).toEqual(["д", "в", "н", "Н"]);
      for (const key of keys) expect(key.whole, `${key.key} in ${row}`).toBe(true);
    });
  }

  it("names every key of a plain round, in Home too, whole at 80 columns", () => {
    for (const home of [false, true]) {
      const store = storeAt(80, bg);
      store.begin();
      if (home) store.setHome("task-0");
      plainRound(store);
      const row = statusOf(store);
      expect(stringWidth(row)).toBeLessThanOrEqual(80);
      expect(keysOf(row).map((key) => key.key)).toEqual(["д", "ч", "в", "н", "Н"]);
      for (const key of keysOf(row)) expect(key.whole, `${key.key} in ${row}`).toBe(true);
    }
  });
});

describe("the status row in Bulgarian", () => {
  it("keeps a chat's private and taint marks when its state is too long for the row", () => {
    const store = storeAt(80, bg);
    store.begin();
    store.push(event("run.started", { threadId: "thread-0", workspaceId: "default" }, "attempt-0"));
    store.markPrivate("task-0");
    store.setTaint("task-0", UNTRUSTED as never);
    store.push(
      event("task.failed", {
        errorCode: "MODEL",
        message: "доставчикът на модела върна грешка 503, опитай отново по-късно, или смени модела от настройките",
      }),
    );
    store.end();
    const row = statusOf(store);
    expect(stringWidth(row)).toBeLessThanOrEqual(80);
    expect(row).toMatch(/^✗ неуспешно:.*… · поверителен · ⚠ Прочетено:/u);
  });

  it("says a stopped turn as a sentence, and nothing after it when there is no offer", () => {
    for (const [prompting, ending] of [
      [true, "Спрях по твое искане. Пиши, за да продължиш (/new за нов чат), или Ctrl-C за изход."],
      [false, "Спрях по твое искане."],
    ] as const) {
      const store = storeAt(120, bg, prompting);
      store.begin();
      store.push(event("run.started", { threadId: "thread-0", workspaceId: "default" }, "attempt-0"));
      store.push(event("task.stopped", { message: "Спрях по твое искане" }));
      store.end();
      if (prompting) store.next("continue");
      expect(statusOf(store)).toBe(ending);
    }
  });

  const wide = new Map(statusRows(1_000, bg));
  for (const columns of WIDTHS) {
    const rows = statusRows(columns, bg);

    it(`is never wider than ${String(columns)} columns`, () => {
      const over = rows.filter(([, row]) => stringWidth(row) > columns).map(([state, row]) => `${state}: ${row}`);
      expect(over).toEqual([]);
    });

    it(`cuts no word at ${String(columns)} columns`, () => {
      const cut = rows
        .filter(([state]) => !state.startsWith("round"))
        .filter(([state, row]) => !cutAtABoundary(row.replace(/… · .*$/u, "…"), wide.get(state) ?? ""))
        .map(([state, row]) => `${state}: ${row}`);
      expect(cut).toEqual([]);
    });

    it(`says every key of a round, a review and an offer whole at ${String(columns)} columns`, () => {
      const whole = rows.filter(([state]) => /^(idle|deciding|review|done|running$)/u.test(state));
      expect(whole.length).toBeGreaterThan(10);
      for (const [state, row] of whole) expect(row, state).toBe(wide.get(state));
      // A round's row may leave its number out, never a key or a key's words.
      for (const [state, row] of rows.filter(([state]) => state.startsWith("round"))) {
        expect(
          keysOf(row).map((key) => key.key),
          state,
        ).toEqual(keysOf(wide.get(state) ?? "").map((key) => key.key));
        for (const key of keysOf(row)) expect(key.whole, `${state}: ${row}`).toBe(true);
      }
    });

    it(`keeps a form's field and a chat's marks in sight at ${String(columns)} columns`, () => {
      for (const [state, row] of rows.filter(([state]) => state.startsWith("form "))) expect(row, state).toMatch(/^✎ .+, \d\/\d: \S/u);
      const marked = rows.find(([state]) => state === "running, private, read untrusted")?.[1] ?? "";
      expect(marked).toContain("поверителен · ⚠ Прочетено:");
    });
  }

  it("names a round's keys in short words, and the card above it in full", () => {
    const round = storeAt(80, bg);
    round.begin();
    plainRound(round);
    expect(statusOf(round)).toBe("⏸ д — одобри, ч — за чата, в — правило, н — откажи, Н — откажи с причина");
    const wider = storeAt(120, bg);
    wider.begin();
    plainRound(wider);
    expect(statusOf(wider)).toBe("⏸ искане 3: д — одобри, ч — за чата, в — правило, н — откажи, Н — откажи с причина");
    const card = round
      .view()
      .committed.slice()
      .map((line) => line.text);
    expect(card.some((line) => line.includes("ч — до края на този чат, в — винаги (правило за работното пространство)"))).toBe(true);
  });

  it("is English's as it always was: words the same, never cut to the terminal", () => {
    const round = storeAt(80, coreEnglish);
    round.begin();
    plainRound(round);
    expect(statusOf(round)).toBe(
      "⏸ round 3: y approves it, s for the rest of this chat, a always (a workspace rule), n rejects it, N rejects with a reason",
    );
  });
});

describe("/help and the panes in Bulgarian", () => {
  for (const columns of WIDTHS) {
    it(`fit ${String(columns)} columns, each description in the help's one column`, () => {
      for (const homeOn of [true, false]) {
        const help = commandHelp(homeOn, columns, bg);
        expect(help.filter((line) => stringWidth(line) > columns)).toEqual([]);
        // A description beside its command starts in the column every other one does; its next rows are under it.
        const starts = help
          .filter((line) => /^ {2}\/\S+(?:, \/\S+)? {2,}\S/u.test(line))
          .map((line) => stringWidth(/^ {2}\/\S+(?:, \/\S+)? {2,}/u.exec(line)?.[0] ?? ""));
        expect(new Set(starts)).toEqual(new Set([16]));
        for (const line of help.filter((line) => /^ {3,}\S/u.test(line))) expect(line).toMatch(/^ {16}\S/u);
      }
      const lines = [
        ...agentsPane(
          {
            agents: [
              {
                agentId: "brief",
                workspaceId: "default",
                name: "Брифинг",
                description: "Сутрешни бюлетини",
                enabled: true,
                createdAt: AT,
                updatedAt: AT,
                systemPromptLength: 1,
              },
            ],
            truncated: true,
            unreadable: ["default/broken"],
            mailbox: {
              taskId: "task-1",
              pending: [
                {
                  messageId: "m-1",
                  kind: "request",
                  senderAgentId: "lead",
                  senderTaskId: "task-0",
                  createdAt: AT,
                  expiresAt: "2026-09-19T11:58:00.000Z",
                },
              ],
              truncated: true,
            },
          } as never,
          "default",
          NOW,
          undefined,
          bg,
        ),
        ...agentsPane({ agents: [], truncated: false }, "default", NOW, "task-9", bg),
        ...schedulesPane({ schedules: [], truncated: true } as never, "default", NOW, bg),
        ...approvalsPane(
          {
            rows: [{ record: { approvalId: "a", taskId: "task-1", callId: "a", toolId: "fs.write", steps: 4, createdAt: AT }, task: {} }],
            truncated: true,
          } as never,
          "default",
          undefined,
          NOW,
          bg,
        ),
        ...credentialsPane({ credentials: [], unusable: ["Bad Name"] }, bg),
        ...pluginsPane({ plugins: [] }, bg),
        ...needsPane({ needs: [], truncated: true } as never, "default", undefined, NOW, bg),
      ];
      expect(lines.filter((line) => stringWidth(line) > columns)).toEqual([]);
      // No message kind is left in English.
      expect(lines.join("\n")).toContain("молба от lead");
    });
  }

  it("lines up /chats' columns whatever kind a chat is", () => {
    const row = (taskId: string, chatKind: string | undefined, status = "completed") =>
      ({ taskId, status, principalId: "operator", title: `${taskId} заглавие`, ...(chatKind === undefined ? {} : { chatKind }) }) as never;
    const lines = chatsPane(
      {
        rows: [
          row("task-h", "home"),
          row("task-c", undefined),
          row("task-s", "side", "running"),
          row("task-r", "run", "awaiting_approval"),
        ],
        truncated: false,
      } as never,
      "default",
      { principalId: "operator", homeOn: true },
      bg,
    ).filter((line) => line.includes("заглавие"));
    expect(lines.map((line) => line.split(/ {2,}/u)[2])).toEqual(["„Начало“", "чат", "страничен", "изпълнение"]);
    // The status and the title each start in one column.
    for (const word of ["completed|running|awaiting_approval", "task-\\S+ заглавие"]) {
      const starts = lines.map((line) => stringWidth(line.slice(0, line.search(new RegExp(`(?<= {2})(?:${word})`, "u")))));
      expect(new Set(starts).size).toBe(1);
    }
  });
});

describe("the text commands in Bulgarian", () => {
  const heartbeat = {
    config: {
      enabled: true,
      everyMs: 30 * 60_000,
      deepCheckEveryMs: 4 * 60 * 60_000,
      activeHours: { start: "08:00", end: "20:00" },
      daysOfWeek: [1, 2],
      tellMe: "urgent-now",
      maxNowPerHour: 2,
      targets: [],
      providerId: "builtin",
      budget: { modelTicksPerDay: 24, tokensPerDay: 50_000 },
      extraTools: [],
      fetchHosts: [],
      disabledSources: [],
      instructions: "",
      mutes: [],
      providerEgress: {},
    },
    providers: [],
    providerDetails: [],
    timezone: "Europe/Sofia",
    hostRunning: false,
    revision: 3,
  } as never;
  const doctor = {
    buildId: "dev",
    node: { ok: true, version: "24.1.0", required: ">=24" },
    integrity: { checked: true, ok: true, mode: "quick", problems: [] },
    migrations: { unknown: [], latest: "0042" },
    modelConfiguration: { connections: [], workspaceDefault: null },
    onboarding: { complete: false },
    sandbox: { tier: "full", mechanism: "seatbelt" },
    video: { enabled: false },
    disk: { freeBytes: 40 * 1024 ** 3 },
  } as unknown as DoctorDocument;
  const steps = [
    { kind: "model", state: "todo", detail: "" },
    { kind: "about", state: "skipped", detail: "" },
    { kind: "search", state: "blocked", detail: "" },
  ] as never[];

  for (const columns of WIDTHS) {
    it(`fit ${String(columns)} columns, a long line going on deeper, never cut inside a word`, () => {
      for (const text of [
        heartbeatStatusText(heartbeat, bg),
        doctorSummary(doctor, false, bg),
        steps.map((step) => stepLine(step, bg)).join("\n"),
      ]) {
        const page = pageIn(bg, text, columns);
        expect(page.split("\n").filter((line) => stringWidth(line) > columns)).toEqual([]);
        // The same words in the same order: only spaces became line breaks.
        expect(page.split(/\s+/u).join(" ")).toBe(text.split(/\s+/u).join(" "));
      }
    });
  }

  it("leaves English as it always was, however wide its lines", () => {
    const text = heartbeatStatusText(heartbeat);
    expect(pageIn(coreEnglish, text, 40)).toBe(text);
  });

  it("leaves a page whole when no width is known: a pipe, or a terminal that says 0", () => {
    const text = heartbeatStatusText(heartbeat, bg);
    expect(pageIn(bg, text, undefined)).toBe(text);
    expect(pageIn(bg, text, 0)).toBe(text);
  });
});

describe("one row, cut where a part, a clause or a word ends", () => {
  it("keeps what fits, and marks the cut", () => {
    expect(fittedRow("short", 80)).toBe("short");
    // The last end that fits, of a part or a clause alike.
    expect(fittedRow("едно · две, три четири", 12)).toBe("едно · две…");
    expect(fittedRow("едно, две, три четири", 12)).toBe("едно, две…");
    expect(fittedRow("едно две три", 9)).toBe("едно две…");
    expect(fittedRow("абвгдежзий", 5)).toBe("абвг…");
    for (const columns of [5, 9, 12, 20])
      expect(stringWidth(fittedRow("едно · две, три четири пет", columns))).toBeLessThanOrEqual(columns);
  });

  it("wraps each line of a page alone, deeper than its own indent", () => {
    expect(wrappedLines("едно две три\n  четири пет шест", 10)).toBe("едно две\n  три\n  четири\n    пет\n    шест");
    // The first line takes the whole width; only the lines after it go deeper.
    expect(wrappedLines("    a b c d e f g", 10)).toBe("    a b c\n      d e\n      f g");
  });

  it("leaves a row alone with no width, and never makes it wider than one", () => {
    expect(fittedRow("", 10)).toBe("");
    expect(fittedRow("едно две", 0)).toBe("едно две");
    expect(fittedRow("едно две", 1)).toBe("…");
    const wide = fittedRow("日本語の文字列", 7);
    expect(stringWidth(wide)).toBeLessThanOrEqual(7);
    expect(wide.endsWith("…")).toBe(true);
    expect(wrappedLines("едно две три", 0)).toBe("едно две три");
  });

  it("keeps escapes, aligned columns and over-long words in a page", () => {
    const red = "\u001b[31mдума\u001b[0m дума дума";
    const wrapped = wrappedLines(red, 10);
    expect(wrapped.split("\u001b").length).toBe(red.split("\u001b").length);
    expect(wrapped.split("\n").every((line) => stringWidth(line) <= 10)).toBe(true);
    expect(
      wrappedLines("x".repeat(30), 10)
        .split("\n")
        .every((line) => stringWidth(line) <= 10),
    ).toBe(true);
    // Columns aligned with runs of spaces are a table row: left whole.
    expect(wrappedLines("    a  b   c dddd eeee ffff", 10)).toBe("    a  b   c dddd eeee ffff");
  });
});
