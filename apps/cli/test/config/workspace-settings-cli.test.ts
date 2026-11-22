import { join } from "node:path";

import { DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS, hostTimeZone, type ModelPort, type WorkspaceSettingsAnswer } from "@tavi/contracts";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import type { ConfigDependencies } from "../../src/server/config-commands.js";
import { workspaceSettingsCommand } from "../../src/server/workspace-settings-commands.js";
import { SqliteStore } from "../support/database-fixture.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi config` and the `workspace-settings` command: the parser, the offline path, and the owner's compare-and-set.
 */

const directories = temporaryDirectories({ prefix: "tavi-config-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const answering = (): ModelPort => ({
  async stream(request, options) {
    options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "ok" });
    return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
  },
});

async function owner(
  extra: { readonly taintPolicy?: "off" | "observe" | "enforce" } = {},
): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const directory = directories.create();
  const handle = await serve(
    fixtureServeOptions(directory, extra),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { modelOverride: answering() },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory };
}

describe("parsing tavi config", () => {
  it("reads get, set and unset with their keys", () => {
    expect(parseArgs(["config", "get"])).toEqual({ command: "config", config: { action: "get", format: "text" } });
    expect(parseArgs(["config", "get", "workspace.timezone", "--format", "json"])).toEqual({
      command: "config",
      format: "json",
      config: { action: "get", key: "workspace.timezone", format: "json" },
    });
    expect(parseArgs(["config", "set", "workspace.timezone", "Europe/Berlin", "--workspace", "w1", "--expected-revision", "2"])).toEqual({
      command: "config",
      config: { action: "set", key: "workspace.timezone", value: "Europe/Berlin", expectedRevision: 2, workspaceId: "w1", format: "text" },
    });
    expect(parseArgs(["config", "unset", "workspace.timezone", "--data-dir", "/tmp/x"])).toEqual({
      command: "config",
      config: { action: "unset", key: "workspace.timezone", format: "text", dataDirectory: "/tmp/x" },
    });
  });

  it("refuses an unknown key in one line naming the nearest key, and the wrong number of arguments", async () => {
    expect(() => parseArgs(["config", "set", "workspace.timezon", "Europe/Berlin"])).toThrow(
      'Unknown config key "workspace.timezon"; did you mean workspace.timezone? `tavi config get` lists every key',
    );
    expect(() => parseArgs(["config", "get", "nope.key"])).toThrow(
      'Unknown config key "nope.key"; `tavi config get` lists every key, and `tavi config --help` describes each',
    );
    // One line on stderr, not the whole help after it.
    const typo = capture();
    expect(await main(["config", "unset", "workspace.timezon"], { io: typo.io })).toBe(EXIT.usage);
    expect(typo.stderr().trimEnd().split("\n")).toHaveLength(1);
    expect(() => parseArgs(["config", "set", "workspace.timezone"])).toThrow(UsageError);
    expect(() => parseArgs(["config", "unset"])).toThrow(UsageError);
    expect(() => parseArgs(["config", "get", "workspace.timezone", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["config", "get", "--expected-revision", "1"])).toThrow(/does not accept --expected-revision/);
    // A repeat is said before its missing value: the second --workspace is the slip.
    expect(() => parseArgs(["config", "get", "--workspace", "a", "--workspace"])).toThrow("config get received --workspace twice");
    expect(() => parseArgs(["system-prompt", "show", "--workspace", "a", "--workspace"])).toThrow(
      "system-prompt show received --workspace twice",
    );
    expect(() => parseArgs(["router", "status", "--workspace", "a", "--workspace"])).toThrow("Unsupported or repeated router option");
    expect(() => parseArgs(["config", "reset"])).toThrow(/Unknown config action/);
  });
});

describe("parsing the task summary keys", () => {
  it("reads activity.summaries and activity.summaryModel", () => {
    expect(parseArgs(["config", "set", "activity.summaries", "off"])).toEqual({
      command: "config",
      config: { action: "set", key: "activity.summaries", value: "off", format: "text" },
    });
    expect(parseArgs(["config", "set", "activity.summaryModel", "openrouter/openai/gpt-4.1-mini"])).toEqual({
      command: "config",
      config: { action: "set", key: "activity.summaryModel", value: "openrouter/openai/gpt-4.1-mini", format: "text" },
    });
    expect(parseArgs(["config", "unset", "activity.summaryModel"])).toEqual({
      command: "config",
      config: { action: "unset", key: "activity.summaryModel", format: "text" },
    });
  });
});

describe("parsing the browser key", () => {
  it("reads browser.noThumbnailHosts", () => {
    expect(parseArgs(["config", "set", "browser.noThumbnailHosts", "a.com,*.bank"])).toEqual({
      command: "config",
      config: { action: "set", key: "browser.noThumbnailHosts", value: "a.com,*.bank", format: "text" },
    });
    expect(parseArgs(["config", "unset", "browser.noThumbnailHosts"])).toEqual({
      command: "config",
      config: { action: "unset", key: "browser.noThumbnailHosts", format: "text" },
    });
  });
});

describe("parsing security.taint", () => {
  it("reads permissions taint with or without a mode, and serve --taint-policy", () => {
    expect(parseArgs(["permissions", "taint"])).toMatchObject({
      command: "permissions",
      permissions: { action: "taint", workspaceId: "default", format: "text" },
    });
    expect(parseArgs(["permissions", "taint", "enforce", "--workspace", "w1"])).toMatchObject({
      command: "permissions",
      permissions: { action: "taint", taintMode: "enforce", workspaceId: "w1" },
    });
    expect(() => parseArgs(["permissions", "taint", "strict"])).toThrow(/permissions taint takes off, observe or enforce/);
    expect(() => parseArgs(["permissions", "taint", "off", "observe"])).toThrow(UsageError);
    expect(parseArgs(["config", "set", "security.taint", "enforce"])).toMatchObject({
      config: { action: "set", key: "security.taint", value: "enforce" },
    });
    expect(parseArgs(["serve", "--taint-policy", "enforce"])).toMatchObject({ command: "serve", serve: { taintPolicy: "enforce" } });
    expect((parseArgs(["serve"]) as { serve: { taintPolicy?: string } }).serve.taintPolicy).toBeUndefined();
    expect(() => parseArgs(["serve", "--taint-policy", "strict"])).toThrow(/--taint-policy must be one of off, observe, enforce/);
  });
});

describe("security.taint offline and on an owner", () => {
  it("defaults to enforce, and permissions taint and tavi config set and show it", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["permissions", "taint", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("security.taint = enforce (default)\n");
    const set = capture();
    expect(await main(["permissions", "taint", "enforce", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("security.taint = enforce (set)\n");
    const json = capture();
    expect(await main(["config", "get", "security.taint", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.out())).toMatchObject({ settings: { securityTaint: "enforce" }, effective: { securityTaint: "enforce" } });
    // The CLI may lower it: only a page is held to raising it.
    const lowered = capture();
    expect(await main(["config", "set", "security.taint", "off", "--data-dir", directory], { io: lowered.io })).toBe(EXIT.ok);
    expect(lowered.out()).toBe("security.taint = off (set)\n");
    const unset = capture();
    expect(await main(["config", "unset", "security.taint", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("security.taint = enforce (default)\n");
    const bad = capture();
    expect(await main(["config", "set", "security.taint", "strict", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.err()).toContain('"strict" is not a taint mode');
  });

  it("an owner's serve --taint-policy is the mode in force over the workspace's own, and says so", async () => {
    const { directory, client } = await owner({ taintPolicy: "enforce" });
    const shown = capture();
    expect(await main(["permissions", "taint", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("security.taint = enforce (serve --taint-policy; this workspace's own is enforce) (default)\n");
    const set = capture();
    expect(await main(["permissions", "taint", "off", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("security.taint = enforce (serve --taint-policy; this workspace's own is off) (set)\n");
    expect((await client.request("workspace-settings", { action: "get" }, "taint-get")).result).toMatchObject({
      settings: { securityTaint: "off" },
      effective: { securityTaint: "enforce" },
      taintPolicy: "enforce",
    });
  });

  it("a page may raise security.taint, never lower it", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const deps = { repositories: store.asPort().repositories, fromBridge: true, now: () => new Date() } as unknown as ConfigDependencies;
      expect(await workspaceSettingsCommand(deps, { action: "set", key: "securityTaint", value: "enforce" })).toMatchObject({
        ok: true,
        result: { effective: { securityTaint: "enforce" } },
      });
      for (const lower of [
        { action: "set", key: "securityTaint", value: "observe" },
        { action: "set", key: "securityTaint", value: "off" },
      ] as const) {
        const refused = await workspaceSettingsCommand(deps, lower);
        expect(refused, JSON.stringify(lower)).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
      }
      expect((await store.asPort().repositories.workspaceSettings.get("default")).settings.securityTaint).toBe("enforce");
      // The write is held to the revision the check read: a stale one is a conflict, never a write.
      expect(
        await workspaceSettingsCommand(deps, { action: "set", key: "securityTaint", value: "enforce", expectedRevision: 0 }),
      ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      // The CLI's own write is not held to it.
      expect(
        await workspaceSettingsCommand({ ...deps, fromBridge: false } as ConfigDependencies, {
          action: "set",
          key: "securityTaint",
          value: "off",
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await store.close();
    }
  });
});

describe("tavi config offline", () => {
  it("turns task summaries off and on and names the summary model", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe(
      `workspace.timezone = ${hostTimeZone()} (default: host zone)\noperator.name = unset (default)\nworkspace.locale = en (default)\nactivity.summaries = on (default)\nactivity.summaryModel = the fast role when bound, else the task's own model (default)\n` +
        `browser.noThumbnailHosts = ${DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS.join(",")} (default)\n` +
        "browser.sessionIdleMinutes = 30 minutes (default)\nbrowser.downloadMaxMiB = 256 MiB (default)\nbrowser.visionEngine = generic (default)\n" +
        "desktop.grantedApps = none (default)\n" +
        "ui.roles = built-in (default)\nui.placements = each manifest's own (default)\nchat.home = on (default)\nchat.home-dm = off (default)\nmodels.keptRequests = 10 (default)\nmodels.maxOutputTokens = 16384 (default)\nscheduled.monthlyTokenBudget = none (default)\nmodels.promptLayout = v2 (default)\nmodels.toolDeferral = auto (default)\ntasks.home = tavi (default)\ntravel.flightSearch = on (default)\ntravel.googleFlights = on (default)\nskills.suggestions = on (default)\npdf.enabled = on (default)\nvideo.enabled = on (default)\nvideo.keepDays = 30 days (default)\ntools.redactResults = on (default)\ntools.parallelReads = 8 (default)\nmemory = defaults (default)\nsecurity.taint = enforce (default)\nsecurity.injectionDetector = patterns (default)\nmcp.servers = none (default)\nmcp.people = none (default)\nsandbox.domains = none (default)\nsandbox.network = granted (default)\n",
    );
    const off = capture();
    expect(await main(["config", "set", "activity.summaries", "off", "--data-dir", directory], { io: off.io })).toBe(EXIT.ok);
    expect(off.out()).toBe("activity.summaries = off (set)\n");
    const model = capture();
    expect(
      await main(
        ["config", "set", "activity.summaryModel", "openrouter/openai/gpt-4.1-mini", "--format", "json", "--data-dir", directory],
        { io: model.io },
      ),
    ).toBe(EXIT.ok);
    expect(JSON.parse(model.out())).toMatchObject({
      settings: { activitySummaries: false, activitySummaryModel: { connectionId: "openrouter", model: "openai/gpt-4.1-mini" } },
      effective: { activitySummaries: false },
    });
    const on = capture();
    expect(await main(["config", "unset", "activity.summaries", "--data-dir", directory], { io: on.io })).toBe(EXIT.ok);
    expect(on.out()).toBe("activity.summaries = on (default)\n");

    const badSwitch = capture();
    expect(await main(["config", "set", "activity.summaries", "sometimes", "--data-dir", directory], { io: badSwitch.io })).toBe(
      EXIT.usage,
    );
    expect(badSwitch.err()).toContain('"sometimes" is not on or off');
    const badModel = capture();
    expect(await main(["config", "set", "activity.summaryModel", "gpt-4.1", "--data-dir", directory], { io: badModel.io })).toBe(
      EXIT.usage,
    );
    expect(badModel.err()).toContain("<connection>/<model>");
  });

  it("sets and clears the most one model call may write", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "models.maxOutputTokens", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("models.maxOutputTokens = 16384 (default)\n");
    const set = capture();
    expect(
      await main(["config", "set", "models.maxOutputTokens", "4096", "--format", "json", "--data-dir", directory], { io: set.io }),
      set.err(),
    ).toBe(EXIT.ok);
    expect(JSON.parse(set.out())).toMatchObject({ settings: { maxOutputTokens: 4096 }, effective: { maxOutputTokens: 4096 } });
    for (const bad of ["255", "1000001", "lots"]) {
      const refused = capture();
      expect(await main(["config", "set", "models.maxOutputTokens", bad, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
      expect(refused.err()).toContain("is not a number of tokens from 256 to 1000000");
    }
    const cleared = capture();
    expect(await main(["config", "unset", "models.maxOutputTokens", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("models.maxOutputTokens = 16384 (default)\n");
  });

  it("sets and clears how many model requests a task keeps", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "models.keptRequests", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("models.keptRequests = 10 (default)\n");
    const none = capture();
    expect(await main(["config", "set", "models.keptRequests", "0", "--format", "json", "--data-dir", directory], { io: none.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(none.out())).toMatchObject({ settings: { keptModelRequests: 0 }, effective: { keptModelRequests: 0 } });
    const more = capture();
    expect(await main(["config", "set", "models.keptRequests", "200", "--data-dir", directory], { io: more.io })).toBe(EXIT.ok);
    expect(more.out()).toBe("models.keptRequests = 200 (set)\n");
    for (const bad of ["-1", "1001", "ten", "2.5"]) {
      const refused = capture();
      expect(await main(["config", "set", "models.keptRequests", bad, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
      expect(refused.err()).toContain("is not a count from 0 to 1000");
    }
    const cleared = capture();
    expect(await main(["config", "unset", "models.keptRequests", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("models.keptRequests = 10 (default)\n");
    const layout = capture();
    expect(await main(["config", "set", "models.promptLayout", "v1", "--format", "json", "--data-dir", directory], { io: layout.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(layout.out())).toMatchObject({ settings: { promptLayout: "v1" }, effective: { promptLayout: "v1" } });
    const badLayout = capture();
    expect(await main(["config", "set", "models.promptLayout", "v3", "--data-dir", directory], { io: badLayout.io })).toBe(EXIT.usage);
    expect(badLayout.err()).toContain("is not a prompt layout: v1 or v2");
    const layoutCleared = capture();
    expect(await main(["config", "unset", "models.promptLayout", "--data-dir", directory], { io: layoutCleared.io })).toBe(EXIT.ok);
    expect(layoutCleared.out()).toBe("models.promptLayout = v2 (default)\n");
    const flightsOff = capture();
    expect(
      await main(["config", "set", "travel.googleFlights", "off", "--format", "json", "--data-dir", directory], { io: flightsOff.io }),
      flightsOff.out(),
    ).toBe(EXIT.ok);
    expect(JSON.parse(flightsOff.out())).toMatchObject({
      settings: { travelGoogleFlights: false },
      effective: { travelFlightSearch: true, travelGoogleFlights: false },
    });
  });

  it("sets and clears how many days a video from outside is kept", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "video.keepDays", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("video.keepDays = 30 days (default)\n");
    const week = capture();
    expect(await main(["config", "set", "video.keepDays", "7", "--format", "json", "--data-dir", directory], { io: week.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(week.out())).toMatchObject({ settings: { videoKeepDays: 7 }, effective: { videoKeepDays: 7 } });
    for (const bad of ["0", "3651", "abc", "1.5"]) {
      const refused = capture();
      expect(await main(["config", "set", "video.keepDays", bad, "--data-dir", directory], { io: refused.io }), bad).toBe(EXIT.usage);
    }
    const cleared = capture();
    expect(await main(["config", "unset", "video.keepDays", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("video.keepDays = 30 days (default)\n");
  });

  it("sets and clears the apps desktop control may act in, and refuses a list it cannot hold", async () => {
    const directory = directories.create();
    const set = capture();
    expect(
      await main(["config", "set", "desktop.grantedApps", "com.apple.TextEdit, Notes,Notes", "--format", "json", "--data-dir", directory], {
        io: set.io,
      }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(set.out())).toMatchObject({ settings: { desktopGrantedApps: ["com.apple.TextEdit", "Notes"] } });
    const shown = capture();
    expect(await main(["config", "get", "desktop.grantedApps", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("desktop.grantedApps = com.apple.TextEdit,Notes (set)\n");
    for (const bad of [" , ", "x".repeat(201), Array.from({ length: 65 }, (_, index) => `app${index}`).join(",")]) {
      const refused = capture();
      expect(await main(["config", "set", "desktop.grantedApps", bad, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    }
    const none = capture();
    expect(await main(["config", "set", "desktop.grantedApps", "none", "--data-dir", directory], { io: none.io })).toBe(EXIT.ok);
    expect(none.out()).toBe("desktop.grantedApps = none (set)\n");
    const cleared = capture();
    expect(await main(["config", "unset", "desktop.grantedApps", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("desktop.grantedApps = none (default)\n");
  });

  it("sets and clears how long an unused browser session stays open, and the largest download", async () => {
    const directory = directories.create();
    const idle = capture();
    expect(
      await main(["config", "set", "browser.sessionIdleMinutes", "0", "--format", "json", "--data-dir", directory], { io: idle.io }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(idle.out())).toMatchObject({
      settings: { browserSessionIdleMinutes: 0 },
      effective: { browserSessionIdleMinutes: 0 },
    });
    const shown = capture();
    expect(await main(["config", "get", "browser.sessionIdleMinutes", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("browser.sessionIdleMinutes = until closed (set)\n");
    for (const [key, bad] of [
      ["browser.sessionIdleMinutes", "1441"],
      ["browser.sessionIdleMinutes", "-1"],
      ["browser.downloadMaxMiB", "0"],
      ["browser.downloadMaxMiB", "4097"],
      ["browser.downloadMaxMiB", "1.5"],
    ] as const) {
      const refused = capture();
      expect(await main(["config", "set", key, bad, "--data-dir", directory], { io: refused.io }), `${key} ${bad}`).toBe(EXIT.usage);
    }
    const big = capture();
    expect(await main(["config", "set", "browser.downloadMaxMiB", "1024", "--data-dir", directory], { io: big.io })).toBe(EXIT.ok);
    expect(big.out()).toBe("browser.downloadMaxMiB = 1024 MiB (set)\n");
    const cleared = capture();
    expect(await main(["config", "unset", "browser.downloadMaxMiB", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("browser.downloadMaxMiB = 256 MiB (default)\n");
  });

  it("chooses what drives acting by sight, generic unless set", async () => {
    const directory = directories.create();
    const set = capture();
    expect(await main(["config", "set", "browser.visionEngine", "native", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("browser.visionEngine = native (set)\n");
    const refused = capture();
    expect(await main(["config", "set", "browser.visionEngine", "vendor", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    const cleared = capture();
    expect(await main(["config", "unset", "browser.visionEngine", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.out()).toBe("browser.visionEngine = generic (default)\n");
  });

  it("turns the Home chat off and on, on by default", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "chat.home", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("chat.home = on (default)\n");
    const off = capture();
    expect(await main(["config", "set", "chat.home", "off", "--format", "json", "--data-dir", directory], { io: off.io })).toBe(EXIT.ok);
    expect(JSON.parse(off.out())).toMatchObject({ settings: { homeChat: false }, effective: { homeChat: false } });
    const on = capture();
    expect(await main(["config", "set", "chat.home", "on", "--format", "json", "--data-dir", directory], { io: on.io })).toBe(EXIT.ok);
    expect(JSON.parse(on.out())).toMatchObject({ settings: { homeChat: true }, effective: { homeChat: true } });
    const unset = capture();
    expect(await main(["config", "unset", "chat.home", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("chat.home = on (default)\n");
    const bad = capture();
    expect(await main(["config", "set", "chat.home", "maybe", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.err()).toContain('"maybe" is not on or off');
  });

  it("links named chat DM identities to Home only with Home on, naming them in the privacy note", async () => {
    const directory = directories.create();
    // Two Telegram connections and a Mailgun one this directory knows.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    for (const [connectionId, providerId] of [
      ["telegram-default", "telegram"],
      ["telegram-work", "telegram"],
      ["mailgun-default", "mailgun"],
    ] as const) {
      await store.asPort().repositories.messagingConnections.save(
        {
          connectionId,
          providerId,
          workspaceId: "default",
          accountIdentity: "x",
          settings: {},
          credentialRefs: {},
          enabled: false,
          authState: "none",
        },
        "2026-01-01T00:00:00.000Z",
      );
    }
    store.close();
    const shown = capture();
    expect(await main(["config", "get", "chat.home-dm", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe("chat.home-dm = off (default)\n");
    expect(await main(["config", "set", "chat.home", "off", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const refused = capture();
    expect(await main(["config", "set", "chat.home-dm", "telegram-default:42", "--data-dir", directory], { io: refused.io })).toBe(
      EXIT.usage,
    );
    expect(refused.err()).toContain("turn chat.home on first");
    expect(await main(["config", "set", "chat.home", "on", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const malformed = capture();
    expect(await main(["config", "set", "chat.home-dm", "on", "--data-dir", directory], { io: malformed.io })).toBe(EXIT.usage);
    expect(malformed.err()).toContain("is not a DM identity");
    // An email connection, a group's id and a connection never heard from are not chat DMs.
    for (const bad of ["mailgun-default:me@example.com", "telegram-default:-100", "telegram-other:42"]) {
      const invalid = capture();
      expect(await main(["config", "set", "chat.home-dm", bad, "--data-dir", directory], { io: invalid.io })).toBe(EXIT.usage);
      expect(invalid.err()).toContain("is not a sender id on a chat channel's connection");
    }
    const on = capture();
    expect(
      await main(["config", "set", "chat.home-dm", "telegram-default:42,telegram-work:7", "--data-dir", directory], { io: on.io }),
    ).toBe(EXIT.ok);
    expect(on.out()).toContain("chat.home-dm = telegram-default:42,telegram-work:7 (set)\n");
    expect(on.out()).toContain("from telegram-default:42, telegram-work:7 now become turns of your Home");
    const json = capture();
    expect(
      await main(["config", "set", "chat.home-dm", "telegram-default:42", "--format", "json", "--data-dir", directory], { io: json.io }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(json.out())).toMatchObject({
      settings: { homeChat: true, homeDmLink: [{ connectionId: "telegram-default", senderId: "42" }] },
      effective: { homeDmLink: true },
    });
    expect(json.err()).toContain("Privacy:");
    // Home off takes the link out of effect, though it stays set, and says nothing.
    const homeOff = capture();
    expect(await main(["config", "set", "chat.home", "off", "--data-dir", directory], { io: homeOff.io })).toBe(EXIT.ok);
    expect(homeOff.out()).not.toContain("Privacy:");
    const dormant = capture();
    expect(await main(["config", "get", "chat.home-dm", "--data-dir", directory], { io: dormant.io })).toBe(EXIT.ok);
    expect(dormant.out()).toBe("chat.home-dm = telegram-default:42 (off: chat.home is off) (set)\n");
    // Home back on revives the link, and says so again.
    const homeOn = capture();
    expect(await main(["config", "set", "chat.home", "on", "--data-dir", directory], { io: homeOn.io })).toBe(EXIT.ok);
    expect(homeOn.out()).toContain("from telegram-default:42 now become turns of your Home");
    const off = capture();
    expect(await main(["config", "set", "chat.home-dm", "off", "--data-dir", directory], { io: off.io })).toBe(EXIT.ok);
    expect(off.out()).toBe("chat.home-dm = off (default)\n");
  });

  it("sets, shows and clears the browser no-thumbnail hosts, with the default in effect when unset", async () => {
    const directory = directories.create();
    const set = capture();
    expect(
      await main(["config", "set", "browser.noThumbnailHosts", "Mail.Example.com, *.BANK", "--data-dir", directory], { io: set.io }),
    ).toBe(EXIT.ok);
    expect(set.out()).toBe("browser.noThumbnailHosts = mail.example.com,*.bank (set)\n");
    const json = capture();
    expect(await main(["config", "get", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.out())).toMatchObject({
      settings: { browserNoThumbnailHosts: ["mail.example.com", "*.bank"] },
      effective: { browserNoThumbnailHosts: ["mail.example.com", "*.bank"] },
    });
    const none = capture();
    expect(await main(["config", "set", "browser.noThumbnailHosts", "none", "--data-dir", directory], { io: none.io })).toBe(EXIT.ok);
    expect(none.out()).toBe("browser.noThumbnailHosts = none (set)\n");
    const unset = capture();
    expect(await main(["config", "unset", "browser.noThumbnailHosts", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe(`browser.noThumbnailHosts = ${DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS.join(",")} (default)\n`);
    const bad = capture();
    expect(
      await main(["config", "set", "browser.noThumbnailHosts", "a.com,https://b.com/x", "--data-dir", directory], { io: bad.io }),
    ).toBe(EXIT.usage);
    expect(bad.err()).toContain('"https://b.com/x" is not a host or *.domain');
  });

  it("sets, shows and clears the domains sandbox.run may reach, refusing a bare * and a URL", async () => {
    const directory = directories.create();
    const set = capture();
    expect(
      await main(
        ["config", "set", "sandbox.domains", "PyPI.org, *.pythonhosted.org,api.example.com:443,pypi.org", "--data-dir", directory],
        { io: set.io },
      ),
    ).toBe(EXIT.ok);
    expect(set.out()).toBe("sandbox.domains = pypi.org,*.pythonhosted.org,api.example.com:443 (set)\n");
    const unset = capture();
    expect(await main(["config", "unset", "sandbox.domains", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("sandbox.domains = none (default)\n");
    for (const value of ["*", "*.com", "https://pypi.org/simple"]) {
      const bad = capture();
      expect(await main(["config", "set", "sandbox.domains", value, "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
      expect(bad.err()).toContain("is not a domain sandbox.run may reach");
    }
    const ask = capture();
    expect(await main(["config", "set", "sandbox.network", "Ask", "--data-dir", directory], { io: ask.io })).toBe(EXIT.ok);
    expect(ask.out()).toBe("sandbox.network = ask (set)\n");
    const wrong = capture();
    expect(await main(["config", "set", "sandbox.network", "always", "--data-dir", directory], { io: wrong.io })).toBe(EXIT.usage);
    expect(wrong.err()).toContain("is not a sandbox network mode; use granted or ask");
  });

  it("sets and clears the UI plugin roles and placements as JSON, refusing what the document does not hold", async () => {
    const directory = directories.create();
    const set = capture();
    expect(await main(["config", "set", "ui.roles", '{"browser-view":"off"}', "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe('ui.roles = {"browser-view":"off"} (set)\n');
    const placed = capture();
    expect(await main(["config", "set", "ui.placements", '{"acme.view/live":"hidden"}', "--data-dir", directory], { io: placed.io })).toBe(
      EXIT.ok,
    );
    const bad = capture();
    expect(await main(["config", "set", "ui.roles", '{"chat-view":"x"}', "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.err()).toContain("uiRoles is not valid");
    // A plugin is chosen where its disclosure is shown first.
    const plugin = capture();
    expect(await main(["config", "set", "ui.roles", '{"browser-view":"acme.view"}', "--data-dir", directory], { io: plugin.io })).toBe(
      EXIT.usage,
    );
    expect(plugin.err()).toContain("tavi plugins ui set-role");
    const builtin = capture();
    expect(
      await main(["config", "set", "ui.roles", '{"browser-view":"tavi.browserview"}', "--data-dir", directory], { io: builtin.io }),
    ).toBe(EXIT.ok);
    const notJson = capture();
    expect(await main(["config", "set", "ui.placements", "hidden", "--data-dir", directory], { io: notJson.io })).toBe(EXIT.usage);
    expect(notJson.err()).toContain("uiPlacements takes a JSON object");
    const unset = capture();
    expect(await main(["config", "unset", "ui.roles", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("ui.roles = built-in (default)\n");
  });

  it("sets, reads and clears the workspace timezone", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "workspace.timezone", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toBe(`workspace.timezone = ${hostTimeZone()} (default: host zone)\n`);

    const set = capture();
    // A lowercase spelling is stored as the platform spells the zone.
    expect(await main(["config", "set", "workspace.timezone", "europe/berlin", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("workspace.timezone = Europe/Berlin (set)\n");

    const json = capture();
    expect(await main(["config", "get", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.out())).toEqual({
      workspaceId: "default",
      revision: 1,
      settings: { timezone: "Europe/Berlin" },
      effective: {
        timezone: "Europe/Berlin",
        locale: "en",
        toolDeferral: "auto",
        tasksHome: "tavi",
        skillSuggestions: true,
        activitySummaries: true,
        browserNoThumbnailHosts: [...DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS],
        homeChat: true,
        homeDmLink: false,
        keptModelRequests: 10,
        maxOutputTokens: 16_384,
        promptLayout: "v2",
        travelFlightSearch: true,
        travelGoogleFlights: true,
        pdfEnabled: true,
        videoEnabled: true,
        videoKeepDays: 30,
        browserSessionIdleMinutes: 30,
        browserDownloadMaxMiB: 256,
        browserVisionEngine: "generic",
        redactToolResults: true,
        parallelReads: 8,
        memory: {
          enabled: true,
          capture: "suggest",
          autoApprove: [],
          digest: "weekly",
          sensitive: "skip",
          retrieval: "lexical",
          consolidation: "off",
          limits: { contextTokens: 8_000, evidence: 10, proposalDays: 30, maxRecords: 5_000 },
          provider: "tavi.memoryprovider",
          providerEgress: { records: false, conversation: false, includePersonal: false },
        },
        securityTaint: "enforce",
        securityInjectionDetector: "patterns",
      },
      hostTimezone: hostTimeZone(),
    });

    const unset = capture();
    expect(await main(["config", "unset", "workspace.timezone", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe(`workspace.timezone = ${hostTimeZone()} (default: host zone)\n`);
  });

  it("sets, reads and clears the operator's name, as one line of plain text", async () => {
    const directory = directories.create();
    const set = capture();
    expect(await main(["config", "set", "operator.name", "  Robin ", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("operator.name = Robin (set)\n");
    const refused = capture();
    expect(await main(["config", "set", "operator.name", "A\u202eB", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.err()).toContain("operator.name takes one line");
    const unset = capture();
    expect(await main(["config", "unset", "operator.name", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("operator.name = unset (default)\n");
  });

  it("sets, reads and clears the language, refusing one Tavi does not speak", async () => {
    const directory = directories.create();
    const set = capture();
    expect(await main(["config", "set", "workspace.locale", "bg", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("workspace.locale = bg (set)\n");
    const refused = capture();
    expect(await main(["config", "set", "workspace.locale", "de", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.err()).toContain('"de" is not a language Tavi speaks; use one of en, bg');
    const unset = capture();
    expect(await main(["config", "unset", "workspace.locale", "--data-dir", directory], { io: unset.io })).toBe(EXIT.ok);
    expect(unset.out()).toBe("workspace.locale = en (default)\n");
  });

  it("refuses a zone the platform does not know, naming the value", async () => {
    const directory = directories.create();
    const refused = capture();
    expect(await main(["config", "set", "workspace.timezone", "Mars/Olympus", "--data-dir", directory], { io: refused.io })).toBe(
      EXIT.usage,
    );
    expect(refused.err()).toContain('"Mars/Olympus" is not an IANA time zone');
  });
});

describe("workspace-settings on a live owner", () => {
  it("applies one key as a compare-and-set, and answers what is in effect", async () => {
    const { handle, client } = await owner();
    const before = await client.request("workspace-settings", { action: "get", workspaceId: "default" }, "get-1");
    expect(before).toMatchObject({ ok: true, result: { revision: 0, settings: {}, effective: { timezone: hostTimeZone() } } });

    const written = await client.request("workspace-settings", { action: "set", key: "timezone", value: "Asia/Tokyo" }, "set-1");
    expect(written).toMatchObject({
      ok: true,
      result: { workspaceId: "default", revision: 1, settings: { timezone: "Asia/Tokyo" }, effective: { timezone: "Asia/Tokyo" } },
    });
    expect((await handle.runtime.store.asPort().repositories.workspaceSettings.get("default")).actor).toBe("operator:cli");

    const stale = await client.request("workspace-settings", { action: "unset", key: "timezone", expectedRevision: 0 }, "stale");
    expect(stale.error?.code).toBe("CONFLICT");
    const invalid = await client.request("workspace-settings", { action: "set", key: "timezone", value: "Nowhere/Land" }, "bad");
    expect(invalid.error).toMatchObject({ code: "INVALID_INPUT" });
    expect(invalid.error?.message).toContain('"Nowhere/Land"');
    expect(((await client.request("workspace-settings", { action: "get" }, "get-2")).result as WorkspaceSettingsAnswer).revision).toBe(1);
  });

  it("routes tavi config through the owner", async () => {
    const { directory } = await owner();
    const set = capture();
    expect(await main(["config", "set", "workspace.timezone", "America/New_York", "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);
    expect(set.out()).toBe("workspace.timezone = America/New_York (set)\n");
    const refused = capture();
    expect(await main(["config", "set", "workspace.timezone", "Mars/Olympus", "--data-dir", directory], { io: refused.io })).toBe(
      EXIT.usage,
    );
    expect(refused.err()).toContain('"Mars/Olympus"');
  });
});
