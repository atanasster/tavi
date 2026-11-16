import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { COMMAND_INDEX } from "../../src/cli/help.js";
import { IDEAS_USAGE, type IdeasCommandOptions } from "../../src/features/ideas/parse.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { ideasAnswerSchema, ideasPayload, ideasResultText } from "../../src/features/ideas/text.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** `tavi ideas`: parsing, the payloads, and the owner and offline paths. */

const directories = temporaryDirectories({ prefix: "tavi-ideas-cli-" });
const handles: ServeHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(dataDirectory: string): Promise<void> {
  const handle = await serve(
    fixtureServeOptions(dataDirectory, { reminderSweepEnabled: false }),
    { dataDirectory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  if ((await findLiveOwner(dataDirectory)) === undefined) throw new Error("serve did not publish discovery");
}

const parsed = (...argv: string[]): IdeasCommandOptions => {
  const command = parseArgs(["ideas", ...argv]);
  if (command.ideas === undefined) throw new Error("not an ideas command");
  return command.ideas;
};
const refused = (...argv: string[]): string => {
  try {
    parseArgs(["ideas", ...argv]);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`ideas ${argv.join(" ")} was accepted`);
};

describe("tavi ideas parsing", () => {
  it("is in the index and has help", () => {
    expect(COMMAND_INDEX).toContain("tavi ideas <action>");
    expect(parseArgs(["ideas", "--help"])).toEqual({ command: "help", usage: IDEAS_USAGE });
  });

  it("reads each action's answer through its schema", () => {
    expect(ideasAnswerSchema(parsed("refresh")).safeParse({ status: "busy" }).success).toBe(true);
    expect(ideasAnswerSchema(parsed("refresh")).safeParse({ status: "maybe" }).success).toBe(false);
    expect(ideasAnswerSchema(parsed("list")).safeParse({ ideas: [], mutedCategories: [], excludedBasis: [] }).success).toBe(false);
    expect(
      ideasAnswerSchema(parsed("list")).safeParse({
        ideas: [],
        mutedCategories: [],
        excludedBasis: [],
        provider: "tavi.ideasagent",
        providers: [],
      }).success,
    ).toBe(true);
  });

  it("reads each action into its payload", () => {
    expect(ideasPayload(parsed("list", "--all"))).toEqual({ action: "list", workspaceId: "default", includeInactive: true });
    expect(ideasPayload(parsed("try", "idea-1", "--workspace", "w2"))).toEqual({ action: "try", workspaceId: "w2", id: "idea-1" });
    expect(ideasPayload(parsed("dismiss", "idea-1"))).toEqual({
      action: "feedback",
      workspaceId: "default",
      signal: "not-interested",
      id: "idea-1",
    });
    expect(ideasPayload(parsed("refresh"))).toEqual({ action: "refresh", workspaceId: "default" });
    expect(ideasPayload(parsed("brief"))).toEqual({ action: "brief", workspaceId: "default" });
    expect(ideasPayload(parsed("brief", ""))).toEqual({ action: "set-brief", workspaceId: "default", text: "" });
    expect(ideasPayload(parsed("off"))).toEqual({ action: "set-settings", workspaceId: "default", changes: { enabled: false } });
    expect(ideasPayload(parsed("restore", "idea-1"))).toEqual({ action: "restore", workspaceId: "default", id: "idea-1" });
    expect(ideasPayload(parsed("reset"))).toEqual({ action: "reset", workspaceId: "default", what: "ledger" });
    expect(ideasPayload(parsed("reset", "sections"))).toEqual({ action: "reset", workspaceId: "default", what: "categories" });
    expect(ideasPayload(parsed("provider"))).toEqual({ action: "list", workspaceId: "default" });
    expect(ideasPayload(parsed("provider", "acme.ideas"))).toEqual({
      action: "set-settings",
      workspaceId: "default",
      changes: { provider: "acme.ideas" },
    });
  });

  it("refuses what an action does not take", () => {
    expect(refused()).toContain("ideas needs an action");
    expect(refused("launch")).toContain("Unknown ideas action");
    expect(refused("try")).toBe("ideas try takes one idea id");
    expect(refused("list", "idea-1")).toBe("ideas list takes no argument");
    expect(refused("refresh", "--all")).toBe("ideas refresh does not accept --all");
    expect(refused("brief", "a", "b")).toContain("one argument");
    expect(refused("provider", "a", "b")).toBe("ideas provider takes at most one provider id");
    expect(refused("restore")).toBe("ideas restore takes one idea id");
    expect(refused("reset", "everything")).toContain("ideas reset takes ledger or sections");
    expect(refused("brief", "x".repeat(2_001))).toContain("at most 2000");
    expect(refused("list", "--format", "xml")).toContain("--format");
  });
});

describe("tavi ideas output", () => {
  const idea = (key: string, overrides: Record<string, unknown> = {}) => ({
    id: `idea-${key}`,
    workspaceId: "default",
    runId: "run-1",
    key,
    category: "travel",
    icon: "✈️",
    title: `I can do ${key}`,
    pitch: `Pitch ${key}.`,
    label: key,
    prompt: `Do ${key}.`,
    basis: [{ kind: "general", ref: "6.1" }],
    providerId: "tavi.ideasagent",
    uses: [{ capability: "web", approval: false }],
    score: 0.5,
    status: "active",
    pinned: false,
    shownRuns: 1,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    expiresAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  });

  it("lists by section with marks and the muted sections", () => {
    const text = ideasResultText(parsed("list", "--all"), {
      ideas: [
        idea("travel.a", { pinned: true, prepared: { taskId: "task-p", text: "Found three flights.", at: "2026-10-19T10:00:00.000Z" } }),
        idea("shopping.b", { category: "shopping", icon: "🛒", status: "snoozed" }),
      ],
      mutedCategories: ["people"],
      excludedBasis: [],
    });
    expect(ideasResultText(parsed("list"), { ideas: [], mutedCategories: [], excludedBasis: [], enabled: false })).toBe(
      "Ideas are off: none are offered (tavi ideas on)\nNo ideas yet",
    );
    expect(text).toBe(
      "Travel & errands\nidea-travel.a\t✈️ I can do travel.a (pinned, ready)\n    Pitch travel.a.\n\nShopping & style\nidea-shopping.b\t🛒 I can do shopping.b (snoozed)\n    Pitch shopping.b.\nMuted: People & culture",
    );
  });

  it("wraps a long pitch at word boundaries to the terminal's columns, 80 in a pipe", () => {
    const pitch =
      "I can look across your recent searches and saved pages for the topics you keep coming back to, and tell you which of them are rising fastest this week.";
    const answer = { ideas: [idea("travel.long", { pitch })], mutedCategories: [], excludedBasis: [] };
    for (const [columns, width] of [
      [undefined, 80],
      [50, 50],
    ] as const) {
      const text = ideasResultText(parsed("list"), answer, columns);
      for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(width);
      expect(text.replace(/\s+/g, " ")).toContain(pitch);
    }
  });

  it("prints the providers with the one in use, and strips control characters from what a provider wrote", () => {
    const list = {
      ideas: [],
      mutedCategories: [],
      excludedBasis: [],
      provider: "acme.ideas",
      providers: [
        { id: "tavi.ideasagent", kind: "builtin", receives: ["memory", "tasks", "brief", "ledger"], ready: true },
        { id: "acme.ideas", kind: "plugin", receives: [], ready: false },
      ],
    };
    expect(ideasResultText(parsed("provider"), list)).toBe(
      "  tavi.ideasagent\tbuiltin\tready\treceives: memory, tasks, brief, ledger\n* acme.ideas\tplugin\tnot ready\treceives: nothing",
    );
    expect(ideasResultText(parsed("provider", "acme.ideas"), { settings: { provider: "acme.ideas" } })).toBe(
      "Ideas now come from acme.ideas",
    );
    expect(ideasResultText(parsed("try", "idea-a"), { prompt: "Do\u001b[31m this", idea: idea("travel.a") })).toBe("Do[31m this");
    // The last run, with a provider's reason cleaned of what would drive the terminal.
    const run = {
      id: "r",
      workspaceId: "default",
      providerId: "acme.ideas",
      trigger: "refresh",
      startedAt: "2026-10-19T10:00:00.000Z",
      outcome: "failed",
      reason: "boom\u001b]0;pwned\u0007",
      generated: 0,
      dropped: 0,
      tokens: 0,
      usd: 0,
    };
    expect(ideasResultText(parsed("list"), { ...list, ideas: [], lastRun: run })).toBe(
      "No ideas yet\nLast run 2026-10-19 10:00 UTC (refresh): failed — boom]0;pwned",
    );
    // What a provider's left-out ideas broke is said under the run.
    expect(
      ideasResultText(parsed("list"), {
        ...list,
        ideas: [],
        lastRun: {
          ...run,
          outcome: "generated",
          dropped: 1,
          reason: "Left out: idea 1: basis.0: a general basis names the idea's templateId, or general",
        },
      }),
    ).toBe(
      "No ideas yet\nLast run 2026-10-19 10:00 UTC (refresh): 0 offered, 1 left out\n  Left out: idea 1: basis.0: a general basis names the idea's templateId, or general",
    );
    expect(ideasResultText(parsed("list"), { ...list, ideas: [], nextAt: "2026-10-20T05:00:00.000Z" })).toBe(
      "No ideas yet\nNext run 2026-10-20 05:00 UTC",
    );
  });

  it("prints the prompt to try and says what a dismissal did", () => {
    expect(ideasResultText(parsed("try", "idea-a"), { prompt: "Do travel.a.", idea: idea("travel.a", { status: "tried" }) })).toBe(
      "Do travel.a.",
    );
    expect(ideasResultText(parsed("dismiss", "idea-a"), { idea: idea("travel.a", { status: "dismissed" }) })).toBe(
      "Dismissed idea-travel.a: it will not be offered again",
    );
    expect(ideasResultText(parsed("dismiss", "idea-a"), {})).toBe("Dismissed");
  });
});

describe("tavi ideas", () => {
  const run = async (dataDirectory: string, ...argv: string[]) => {
    let out = "";
    let err = "";
    const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: false };
    const code = await main(["ideas", ...argv, "--data-dir", dataDirectory], { io });
    return { code, out, err };
  };

  it("works offline: an empty list, the brief, on and off, and no refresh without a host", async () => {
    const dataDirectory = directories.create();
    expect(await run(dataDirectory, "list")).toMatchObject({ code: EXIT.ok, out: "No ideas yet\n" });
    expect((await run(dataDirectory, "brief", "More about the garden.")).out).toBe("Saved the ideas brief\n");
    expect((await run(dataDirectory, "brief")).out).toBe("More about the garden.\n");
    expect((await run(dataDirectory, "off")).out).toBe("Ideas are off\n");
    const refresh = await run(dataDirectory, "refresh");
    expect(refresh.code).not.toBe(EXIT.ok);
    expect(refresh.err).toContain("no ideas host is running");
    expect((await run(dataDirectory, "try", "idea-nope")).code).toBe(EXIT.usage);
  });

  it("works through a live owner", async () => {
    const dataDirectory = directories.create();
    await owner(dataDirectory);
    expect(await run(dataDirectory, "list")).toMatchObject({ code: EXIT.ok, out: "No ideas yet\n" });
    expect((await run(dataDirectory, "brief", "Nothing about money.")).out).toBe("Saved the ideas brief\n");
    const json = await run(dataDirectory, "brief", "--format", "json");
    expect(JSON.parse(json.out)).toEqual({ text: "Nothing about money." });
  });

  it("sets the weekly digest to a connection and a day, turns it off, or prints it", () => {
    expect(ideasPayload(parsed("digest", "tg-1", "Friday"))).toEqual({
      action: "set-settings",
      workspaceId: "default",
      changes: { digest: { channel: "tg-1", weekday: 5 } },
    });
    expect(ideasPayload(parsed("digest", "off"))).toEqual({ action: "set-settings", workspaceId: "default", changes: { digest: null } });
    expect(ideasPayload(parsed("digest"))).toEqual({ action: "settings", workspaceId: "default" });
    expect(() => parsed("digest", "tg-1", "someday")).toThrow(/a day such as mon/u);
    expect(() => parsed("digest", "tg-1", "monkey")).toThrow(/a day such as mon/u);
    expect(ideasPayload(parsed("digest", "tg-1", "sat"))).toMatchObject({ changes: { digest: { weekday: 6 } } });
    expect(() => parsed("digest", "tg-1")).toThrow(/a connection and a day, or off/u);
    const settings = {
      enabled: true,
      provider: "tavi.ideasagent",
      chips: true,
      sources: { memory: true, tasks: true, brief: true },
      volume: 12,
      dailyTokens: 20_000,
      hours: { start: "08:00", end: "22:00" },
    };
    expect(ideasResultText(parsed("digest"), { settings })).toBe("No weekly ideas digest");
    expect(ideasResultText(parsed("digest"), { settings: { ...settings, digest: { channel: "tg-1", weekday: 1 } } })).toBe(
      "The ideas digest goes to your chat on tg-1 each Monday, inside your ideas hours",
    );
  });

  it("sets the hours and the day's budget, or prints them", () => {
    expect(ideasPayload(parsed("hours", "22:00-06:00"))).toEqual({
      action: "set-settings",
      workspaceId: "default",
      changes: { hours: { start: "22:00", end: "06:00" } },
    });
    expect(ideasPayload(parsed("hours"))).toEqual({ action: "settings", workspaceId: "default" });
    expect(() => parsed("hours", "8-22")).toThrow(/a range such as 08:00-22:00/u);
    expect(() => parsed("hours", "08:00-08:00")).toThrow(/a range such as/u);
    expect(ideasPayload(parsed("budget", "0"))).toEqual({ action: "set-settings", workspaceId: "default", changes: { dailyTokens: 0 } });
    expect(() => parsed("budget", "-5")).toThrow(/whole number of tokens/u);
    expect(ideasPayload(parsed("prepare", "on"))).toEqual({
      action: "set-settings",
      workspaceId: "default",
      changes: { prepareExternal: true },
    });
    expect(ideasPayload(parsed("prepare"))).toEqual({ action: "settings", workspaceId: "default" });
    expect(() => parsed("prepare", "maybe")).toThrow(/on or off/u);
    for (const typed of ["", " ", "1e3", "0x10"]) expect(() => parsed("budget", typed)).toThrow(/whole number of tokens/u);
    const settings = {
      enabled: true,
      provider: "tavi.ideasagent",
      chips: true,
      sources: { memory: true, tasks: true, brief: true },
      volume: 12,
      dailyTokens: 0,
      hours: { start: "08:00", end: "22:00" },
    };
    expect(ideasResultText(parsed("budget"), { settings })).toBe("Ideas' model turns are off: ideas keep their plain wording");
    expect(ideasResultText(parsed("hours"), { settings })).toBe(
      "Ideas look once a day between 08:00 and 22:00, in the workspace's timezone",
    );
  });
});
