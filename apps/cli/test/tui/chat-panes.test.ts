import type { AgentsListResult, ApprovalsListResult, SchedulesListResult } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { chatCommand, commandHelp, helpRows, mayBecomeCommand, runnable } from "../../src/tui/commands.js";
import {
  chatsPane,
  agentsPane,
  approvalsPane,
  credentialsPane,
  modelsPane,
  needsPane,
  pluginsPane,
  relative,
  schedulesPane,
} from "../../src/tui/panes.js";

/** `tavi chat`'s status panes: what a command is, and what each pane prints. */

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const AT = "2026-09-19T11:55:00.000Z";

describe("pane commands", () => {
  it("takes exactly a command, in any case, and nothing that merely starts with a slash", () => {
    expect(chatCommand("/agents")).toEqual({ kind: "pane", pane: "agents" });
    expect(chatCommand("  /Schedules ")).toEqual({ kind: "pane", pane: "schedules" });
    expect(chatCommand("/help")).toEqual({ kind: "help" });
    // `/new`: the next prompt starts a task of its own; words after it are no prompt.
    expect(chatCommand("/new")).toEqual({ kind: "new" });
    expect(chatCommand(" /NEW ")).toEqual({ kind: "new" });
    expect(chatCommand("/new task please")).toEqual({ kind: "unknown", typed: "/new task please" });
    expect(mayBecomeCommand("/ne")).toBe(true);
    expect(chatCommand("/?")).toEqual({ kind: "help" });
    expect(chatCommand("/etc/hosts: what is in it?")).toBeUndefined();
    expect(chatCommand("/etc/hosts")).toBeUndefined();
    expect(chatCommand("agents")).toBeUndefined();
    // A lone slash-word that is no command is a typo, not a prompt to send to the model.
    expect(chatCommand("/agent")).toEqual({ kind: "unknown", typed: "/agent" });
    expect(chatCommand(" /Agnets ")).toEqual({ kind: "unknown", typed: "/Agnets" });
  });

  it("takes Home's commands: /side with a topic, /home, /chats, /open <task-id>, /compact", () => {
    expect(chatCommand("/side")).toEqual({ kind: "side" });
    expect(chatCommand("/side  Plan a Trip ")).toEqual({ kind: "side", topic: "Plan a Trip" });
    expect(chatCommand("/HOME")).toEqual({ kind: "home" });
    expect(chatCommand("/chats")).toEqual({ kind: "chats" });
    expect(chatCommand("/compact")).toEqual({ kind: "compact" });
    expect(chatCommand("/open Task-1")).toEqual({ kind: "open", taskId: "Task-1" });
    expect(chatCommand("/open")).toEqual({ kind: "open" });
    expect(chatCommand("/open a b")).toEqual({ kind: "unknown", typed: "/open a b" });
    // `/answer`: the open questions listed, or one answered by its number.
    expect(chatCommand("/answer")).toEqual({ kind: "answer" });
    expect(chatCommand("/answer 2 Use the  docs")).toEqual({ kind: "answer", index: 2, text: "Use the  docs" });
    expect(chatCommand("/answer 2")).toEqual({ kind: "answer", index: 2 });
    expect(chatCommand("/answer two please")).toEqual({ kind: "unknown", typed: "/answer two please" });
    expect(chatCommand("/answer 0 x")).toEqual({ kind: "unknown", typed: "/answer 0 x" });
    expect(chatCommand("/home now")).toEqual({ kind: "unknown", typed: "/home now" });
    expect(chatCommand("/sidebar")).toEqual({ kind: "unknown", typed: "/sidebar" });
    // A topic or an id is still being typed: its keys are the command's.
    expect(mayBecomeCommand("/side plan a")).toBe(true);
    expect(mayBecomeCommand("/open task-")).toBe(true);
    expect(mayBecomeCommand("/comp")).toBe(true);
    expect(mayBecomeCommand("/chats now")).toBe(false);
  });

  it("takes a listed plugin's command as typed, with its words, and runs it once whole", () => {
    expect(mayBecomeCommand("/tal")).toBe(false);
    expect(mayBecomeCommand("/tal", ["tally"])).toBe(true);
    expect(mayBecomeCommand("/tally reset", ["tally"])).toBe(true);
    expect(mayBecomeCommand("/tallyx", ["tally"])).toBe(false);
    expect(runnable("/tally", ["tally"])).toBe(true);
    expect(runnable("/Tally reset", ["tally"])).toBe(true);
    expect(runnable("/tal", ["tally"])).toBe(false);
    expect(runnable("/tally")).toBe(false);
    expect(runnable("/agents", ["tally"])).toBe(true);
  });

  it("words /help for whether Home is on: where a prompt goes, /home, and what /new is", () => {
    // Wide enough that no entry wraps: this is about the words.
    const on = commandHelp(true, 1000).join("\n");
    expect(on).toContain("continues the chat shown, or goes to Home");
    expect(on).toContain("/home         back to your Home");
    expect(on).toContain("the workspace's recent chats, your Home first");
    expect(on).toContain("/new          the same as /side");
    const off = commandHelp(false, 1000).join("\n");
    expect(off).toContain("continues the chat shown, or starts one");
    expect(off).not.toContain("/home");
    expect(off).not.toContain("Home first");
    expect(off).toContain("/new          the next prompt starts a new chat");
    for (const help of [on, off]) expect(help).toMatch(/\/steer <text>[\s\S]*\/answer|\/answer[\s\S]*\/steer <text>/);
  });

  it("wraps /help to the terminal's width, each description's next rows under its column", () => {
    for (const columns of [60, 80, 100, 140]) {
      const rows = commandHelp(true, columns);
      const note = rows.findIndex((row) => row.startsWith("  Typed at the prompt"));
      expect(note).toBeGreaterThan(0);
      rows.forEach((row, index) => {
        expect(row.length, `${columns} columns: ${row}`).toBeLessThan(columns);
        // The divider, a command, or a description's next row under the column; the closing note is indented two.
        expect(row, `${columns} columns`).toMatch(index >= note ? /^ {2}\S/ : /^(─ | {2}\/| {16}\S)/);
      });
    }
    // Nothing is lost by wrapping: the words read the same at any width.
    const words = (columns: number) => commandHelp(true, columns).join(" ").split(/\s+/).join(" ");
    expect(words(60)).toBe(words(1000));
  });

  it("lays out one /help entry: the description at column 16, its next rows under it, a wide command on its own row", () => {
    expect(helpRows("/home", "back to your Home: its newest turns, then type to continue it", 40)).toEqual([
      "  /home         back to your Home: its",
      "                newest turns, then type",
      "                to continue it",
    ]);
    // A command that reaches the column keeps one space before its description.
    expect(helpRows("/credentials set [reference]", "store a credential", 80)).toEqual([
      "  /credentials set [reference] store a credential",
    ]);
    // Too wide to start the description beside it: the command alone, the description under the column.
    expect(helpRows("/models add [id] [base-url] [credential] [model]", "add a connection", 50)).toEqual([
      "  /models add [id] [base-url] [credential] [model]",
      "                add a connection",
    ]);
    // A note with no command is indented two.
    expect(helpRows("", "Typed at the prompt, even while a run is going.", 30)).toEqual([
      "  Typed at the prompt, even",
      "  while a run is going.",
    ]);
  });

  it("knows a command still being typed, so its keys are not y or n", () => {
    expect(mayBecomeCommand("/")).toBe(true);
    expect(mayBecomeCommand("/ag")).toBe(true);
    expect(mayBecomeCommand("/approvals")).toBe(true);
    expect(mayBecomeCommand("/?")).toBe(true);
    expect(mayBecomeCommand("/x")).toBe(false);
    expect(mayBecomeCommand("/agents now")).toBe(false);
    expect(mayBecomeCommand("n")).toBe(false);
    expect(mayBecomeCommand("")).toBe(false);
  });

  it("says how far an instant is, in its largest whole unit", () => {
    expect(relative("2026-09-19T12:00:00.000Z", NOW)).toBe("now");
    expect(relative("2026-09-19T12:00:30.000Z", NOW)).toBe("in 30s");
    expect(relative(AT, NOW)).toBe("5m ago");
    expect(relative("2026-09-19T15:30:00.000Z", NOW)).toBe("in 3h");
    expect(relative("2026-09-16T12:00:00.000Z", NOW)).toBe("3d ago");
    expect(relative("not a time", NOW)).toBe("not a time");
  });
});

describe("the panes", () => {
  it("lists agents, marks a disabled one, names what could not be read, and the followed task's mailbox", () => {
    const result: AgentsListResult = {
      agents: [
        {
          agentId: "brief",
          workspaceId: "default",
          name: "Brief writer",
          description: "Morning briefs",
          enabled: true,
          createdAt: AT,
          updatedAt: AT,
          systemPromptLength: 120,
        },
        { agentId: "old", workspaceId: "default", name: "Retired", enabled: false, createdAt: AT, updatedAt: AT, systemPromptLength: 40 },
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
            expiresAt: "2026-09-19T13:00:00.000Z",
          },
          {
            messageId: "m-2",
            kind: "result",
            senderAgentId: "lead",
            senderTaskId: "task-0",
            createdAt: AT,
            expiresAt: "2026-09-19T11:58:00.000Z",
          },
        ],
        truncated: true,
      },
    };
    expect(agentsPane(result, "default", NOW)).toEqual([
      "─ agents (workspace default) ─",
      "  ● brief — Brief writer · Morning briefs",
      "  ○ old — Retired (disabled)",
      "  … more exist: `tavi agents list` shows every one",
      "  ⚠ unreadable, not shown: default/broken (`tavi doctor`)",
      "  mailbox of task task-1: 2+ waiting to be received",
      "    request from lead (task task-0), 5m ago, expires in 1h",
      "    result from lead (task task-0), 5m ago, expired 2m ago",
      "    … and more",
    ]);
    expect(agentsPane({ agents: [], truncated: false }, "w", NOW)).toEqual([
      "─ agents (workspace w) ─",
      "  none defined (`tavi agents add` defines one)",
      "  mailbox: no task followed here",
    ]);
    // The task followed here is another workspace's: its mailbox is not this pane's.
    expect(agentsPane({ agents: [], truncated: false }, "w", NOW, "task-9").at(-1)).toBe(
      "  mailbox of task task-9: not shown, the task is not in workspace w",
    );
  });

  it("gives each schedule its next fire, or why there is none, and its last", () => {
    const base = {
      workspaceId: "default",
      principalId: "operator",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      lastRunAt: null,
      lastRunTaskId: null,
      lastOutcome: null,
      consecutiveFailures: 0,
      createdAt: AT,
      updatedAt: AT,
    } as const;
    const result = {
      schedules: [
        { ...base, scheduleId: "s-1", name: "armed", enabled: true, nextRunAt: "2026-09-20T12:00:00.000Z" },
        {
          ...base,
          scheduleId: "s-2",
          name: "off",
          enabled: false,
          nextRunAt: null,
          lastRunAt: AT,
          lastRunTaskId: null,
          lastOutcome: "completed",
          consecutiveFailures: 1,
        },
        { ...base, scheduleId: "s-3", name: "unarmed", enabled: true, nextRunAt: null },
      ],
      truncated: false,
    } as unknown as SchedulesListResult;
    expect(schedulesPane(result, "default", NOW)).toEqual([
      "─ schedules (workspace default) ─",
      "  ● armed — next in 1d",
      "  ○ off — disabled",
      "    last 5m ago: completed",
      "    ⚠ 1 failure in a row",
      "  ● unarmed — not armed",
    ]);
    expect(schedulesPane({ schedules: [], truncated: true }, "default", NOW)).toEqual([
      "─ schedules (workspace default) ─",
      "  none (`tavi schedules add` creates one)",
      "  … more exist: `tavi schedules list` shows every one",
    ]);
  });

  it("lists pending approvals a round to a line, and where each is decided", () => {
    const row = (taskId: string, callId: string, toolId: string, steps: number, createdAt = AT) => ({
      record: { approvalId: `approval-${callId}`, taskId, callId, toolId, steps, createdAt },
      task: {},
    });
    const result: ApprovalsListResult = {
      rows: [
        row("task-1", "a", "fs.write", 4, "2026-09-19T11:50:00.000Z"),
        row("task-1", "b", "http.request", 4),
        row("task-2", "c", "fs.delete", 2),
      ],
      truncated: false,
    };
    expect(approvalsPane(result, "default", { taskId: "task-2", decidedWhere: "its card above decides it (y/n)" }, NOW)).toEqual([
      "─ pending approvals (workspace default) ─",
      "  task task-1, round 4: fs.write, http.request — waiting 10m",
      "    `tavi chat --attach task-1` or `tavi approvals approve|reject task-1`",
      "  task task-2, round 2: fs.delete — waiting 5m",
      "    the task followed here: its card above decides it (y/n)",
    ]);
    // Cut by the listing's bound: the last round may miss calls, and is left out.
    expect(approvalsPane({ ...result, truncated: true }, "default", undefined, NOW)).toEqual([
      "─ pending approvals (workspace default) ─",
      "  task task-1, round 4: fs.write, http.request — waiting 10m",
      "    `tavi chat --attach task-1` or `tavi approvals approve|reject task-1`",
      "  … more are pending: `tavi approvals list` shows every one",
    ]);
    // A round the owner stamped a moment ahead of this clock has waited 0s, not "in 3s".
    expect(
      approvalsPane(
        { rows: [row("task-3", "d", "fs.write", 1, "2026-09-19T12:00:03.000Z")], truncated: false },
        "default",
        undefined,
        NOW,
      )[1],
    ).toBe("  task task-3, round 1: fs.write — waiting 0s");
    expect(approvalsPane({ rows: [], truncated: false }, "default", undefined, NOW)).toEqual([
      "─ pending approvals (workspace default) ─",
      "  none",
    ]);
  });

  it("lists credential references by name only, and says which are unusable", () => {
    expect(credentialsPane({ credentials: [] })).toEqual([
      "─ credentials (the owner's store) ─",
      "  none stored",
      "  /credentials set <reference> stores one, its value typed hidden",
    ]);
    expect(credentialsPane({ credentials: ["openai", "stripe.apiKey"], unusable: ["Bad Name"] })).toEqual([
      "─ credentials (the owner's store) ─",
      "  openai, stripe.apiKey",
      "  ⚠ unusable, not a valid reference: Bad Name",
      "  /credentials set <reference> stores one, its value typed hidden",
    ]);
  });

  it("lists plugins with their state in the owner, flagging reviews and failures", () => {
    const base = { tools: [], configFields: {}, config: {}, description: "" } as const;
    const version = (v: string, reviewState: "proposed" | "approved") => ({
      version: v,
      reviewState,
      contentHash: "0".repeat(64),
      installedAt: "2026-09-26T12:00:00.000Z",
      runsOwnerCode: true,
      tools: [],
      configFields: {},
    });
    expect(
      pluginsPane({
        plugins: [
          {
            ...base,
            id: "tavi.persistence",
            kind: "builtin",
            runsOwnerCode: true,
            name: "tavi.persistence",
            enabled: true,
            core: true,
            versions: [],
            phase: "ready",
          },
          {
            ...base,
            id: "tavi.schedules",
            kind: "builtin",
            runsOwnerCode: true,
            name: "tavi.schedules",
            enabled: false,
            core: false,
            versions: [],
            phase: "not_composed",
          },
          {
            ...base,
            id: "acme.weather",
            kind: "external",
            runsOwnerCode: true,
            name: "Weather",
            enabled: true,
            core: false,
            activeVersion: "1.0.0",
            versions: [version("1.0.0", "approved"), version("1.1.0", "proposed")],
            phase: "failed",
            error: "no connection",
          },
        ],
      }),
    ).toEqual([
      "─ plugins (the owner's) ─",
      "  tavi.persistence  enabled, ready (core)",
      "  tavi.schedules  disabled, not_composed",
      "  acme.weather 1.0.0  enabled, failed  ⚑ awaiting review: 1.1.0  ✗ no connection",
      "  tavi plugins (or the canvas's Plugins view) installs, reviews, enables and configures them",
    ]);
  });

  it("says under a routing provider what it receives", () => {
    const router = { features: ["tools" as const], batch: false, pricing: { connectionId: "plugin:acme.router", model: "acme-1" } };
    const lines = pluginsPane({
      plugins: [
        {
          tools: [],
          configFields: {},
          config: {},
          description: "",
          id: "acme.router",
          kind: "external",
          runsOwnerCode: true,
          name: "acme.router",
          enabled: true,
          core: false,
          activeVersion: "1.0.0",
          versions: [
            {
              version: "1.0.0",
              reviewState: "approved",
              contentHash: "0".repeat(64),
              installedAt: "2026-09-26T12:00:00.000Z",
              runsOwnerCode: true,
              tools: [],
              configFields: {},
              router,
            },
          ],
        },
      ],
    });
    expect(lines[2]).toBe(
      "    Routing provider: receives task text and tool descriptions when router egress allows it. One call per feature, priced as plugin:acme.router / acme-1. Its settings and credentials are shared across every workspace that selects it.",
    );
  });

  it("lists every connection, then this workspace's default and role bindings with their fallbacks", () => {
    const connections = [
      { connectionId: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialRef: "openai", defaultModel: "gpt-5" },
      {
        connectionId: "local",
        label: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        credentialRef: "local",
        localOnly: true,
        defaultModel: null,
      },
    ];
    const roles = {
      workspaceDefault: { workspaceId: "default", target: { connectionId: "openai", model: "gpt-5" }, updatedAt: AT },
      roles: [
        {
          workspaceId: "default",
          role: "extraction" as const,
          target: { connectionId: "local", model: "llama3" },
          fallback: [{ connectionId: "openai", model: "gpt-5-mini" }],
          updatedAt: AT,
        },
      ],
      resolved: [
        { role: "main", source: "workspace-default", target: { connectionId: "openai", model: "gpt-5" } },
        { role: "extraction", source: "role-override", target: { connectionId: "local", model: "llama3" } },
        { role: "fast", source: "workspace-default", target: { connectionId: "openai", model: "gpt-5" } },
      ],
    };
    expect(modelsPane(connections, roles, "default")).toEqual([
      "─ models (workspace default) ─",
      "  connections (shared by every workspace):",
      "    openai — https://api.openai.com/v1, credential openai, default gpt-5",
      "    local — http://127.0.0.1:11434/v1, credential local (local only)",
      "  default: openai/gpt-5",
      "  role extraction: local/llama3, then openai/gpt-5-mini",
      "  unbound, on the default: main, fast",
      "  (role bindings are configuration: the owner's own runs use the default)",
    ]);
    // With no default, an unbound role resolves to nothing, and is said to.
    expect(modelsPane([], { workspaceDefault: null, roles: [], resolved: [{ role: "embedding", source: null }] }, "w").slice(-1)).toEqual([
      "  unbound, resolving to nothing: embedding",
    ]);
    expect(modelsPane([], { workspaceDefault: null, roles: [] }, "w")).toEqual([
      "─ models (workspace w) ─",
      "  connections (shared by every workspace):",
      "    none (/models add adds one)",
      "  default: none (/models set-default)",
    ]);
  });

  it("ends with what the last lifecycle sync says of the models in use", () => {
    const empty = { workspaceDefault: null, roles: [] };
    expect(modelsPane([], empty, "w", { checkedAt: null, warnings: [], hint: "set RHUMB_KEY" }).at(-1)).toBe(
      "  lifecycle: not checked (set RHUMB_KEY)",
    );
    expect(modelsPane([], empty, "w", { checkedAt: "2026-11-20T08:00:00.000Z", warnings: [] }).at(-1)).toBe(
      "  lifecycle: no model in use is retiring or redirected (checked 2026-11-20)",
    );
    const lines = modelsPane([], empty, "w", {
      checkedAt: "2026-11-20T08:00:00.000Z",
      warnings: [
        { connectionId: "openai", model: "gpt-5", level: "error", says: ["retired on 2026-11-19"] },
        {
          connectionId: "gemini",
          model: "gemini-2.5-pro",
          level: "warning",
          says: ["answered and billed as gemini-3.8-flash on 2026-12-01"],
        },
      ],
    });
    expect(lines.slice(-2).map((line) => line.replace(/^ {2}\S+ /u, ""))).toEqual([
      "openai/gpt-5 retired on 2026-11-19",
      "gemini/gemini-2.5-pro answered and billed as gemini-3.8-flash on 2026-12-01",
    ]);
    expect(modelsPane([], empty, "w").some((line) => line.includes("lifecycle"))).toBe(false);
    // A gap is said before any all-clear; a mere notice is doctor's.
    expect(
      modelsPane([], empty, "w", {
        checkedAt: "2026-11-01T08:00:00.000Z",
        stale: true,
        unchecked: ["openai/gpt-6"],
        warnings: [{ connectionId: "openai", model: "o3", level: "info", says: ["deprecated on 2026-10-01"] }],
      }).slice(-2),
    ).toEqual(["  lifecycle: stale, the daily sync has not run (tavi models sync)", "  lifecycle: not yet checked: openai/gpt-6"]);
    expect(modelsPane([], empty, "w", { problem: "the owner timed out" }).at(-1)).toBe(
      "  lifecycle: could not be read (the owner timed out)",
    );
  });
});

describe("needsPane", () => {
  it("lists each question with its options and where to answer it, then what else waits", () => {
    const deadlineAt = new Date(NOW + 25 * 60_000).toISOString();
    const question = {
      taskId: "task-2",
      workspaceId: "default",
      principalId: "operator",
      originLabel: "Daily release",
      waitId: "w",
      question: "Ship it?",
      choices: { options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
      deadlineAt,
      askedAt: deadlineAt,
      deliveries: [],
    };
    const lines = needsPane(
      {
        needs: [
          { kind: "question", needId: "question:w", taskId: "task-2", askedAt: deadlineAt, deadlineAt, question },
          {
            kind: "question",
            needId: "question:v",
            taskId: "task-3",
            askedAt: deadlineAt,
            deadlineAt,
            question: { ...question, taskId: "task-3", waitId: "v", originLabel: undefined, choices: undefined },
          },
          {
            kind: "review",
            needId: "review:task-4",
            taskId: "task-4",
            askedAt: deadlineAt,
            review: { taskId: "task-4", workspaceId: "default", principalId: "operator", artifactCount: 2, askedAt: deadlineAt },
          },
        ],
        truncated: false,
      } as never,
      "default",
      "task-2",
      NOW,
    );
    expect(lines[0]).toContain("needs you");
    expect(lines).toContain("  ? task task-2 (Daily release): Ship it? — due " + relative(deadlineAt, NOW));
    expect(lines).toContain("    1. Yes  2. No");
    expect(lines).toContain("    type the answer here");
    expect(lines).toContain("    `tavi answer task-3 <answer>`");
    expect(lines.at(-1)).toContain("2 results to review");
    expect(needsPane({ needs: [], truncated: false }, "default", undefined, NOW)).toEqual([lines[0], "  nothing"]);
  });

  it("marks an approval, a question past due, and a cut listing", () => {
    const past = new Date(NOW - 60_000).toISOString();
    const lines = needsPane(
      {
        needs: [
          {
            kind: "approval",
            needId: "approval:a",
            taskId: "task-5",
            askedAt: past,
            deadlineAt: new Date(NOW + 60 * 60_000).toISOString(),
            approval: { toolId: "fs.write", summary: "write notes.md" },
          },
          {
            kind: "question",
            needId: "question:p",
            taskId: "task-6",
            askedAt: past,
            deadlineAt: past,
            question: { taskId: "task-6", waitId: "p", question: "Still there?", deadlineAt: past, askedAt: past, deliveries: [] },
          },
        ],
        truncated: true,
      } as never,
      "default",
      undefined,
      NOW,
    );
    expect(lines[1]).toBe("  ! task task-5: fs.write write notes.md — due " + relative(new Date(NOW + 60 * 60_000).toISOString(), NOW));
    // The command that decides it from another terminal, as a question names `tavi answer`.
    expect(lines[2]).toBe("    `tavi approvals approve|reject task-5`");
    expect(lines[3]).toBe("  ? task task-6: Still there? — past due");
    expect(lines.at(-1)).toBe("  … more are waiting: `tavi needs` shows them");
  });
});

describe("chatsPane", () => {
  it("marks a private chat in /chats", () => {
    const row = (taskId: string, memoryMode?: string) =>
      ({
        taskId,
        status: "completed",
        chatKind: "chat",
        title: `${taskId} title`,
        ...(memoryMode === undefined ? {} : { memoryMode }),
      }) as never;
    const lines = chatsPane({ rows: [row("task-p", "private"), row("task-o")], truncated: false } as never, "default", {
      principalId: "operator",
      homeOn: false,
    });
    expect(lines.find((line) => line.includes("task-p"))).toContain("private · task-p title");
    expect(lines.find((line) => line.includes("task-o"))).not.toContain("private");
  });
});
