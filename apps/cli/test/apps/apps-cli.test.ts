import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConnectableApp } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { appsAnswerText, appsListText } from "../../src/features/apps/text.js";
import { catalogRefOf } from "../../src/features/apps/parse.js";
import { appsAddedText, runAppsAccountCommand, type AppsAsk } from "../../src/features/apps/client.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";

/** `tavi apps`. */

const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

const parsed = (...argv: string[]) => parseArgs(["apps", ...argv]).apps;

const app = (extra: Partial<ConnectableApp> = {}): ConnectableApp => ({
  appId: "todoist",
  name: "Todoist",
  summary: "Your schedule.",
  category: "calendar",
  source: { kind: "mcp", pluginIds: ["mcp.todoist"], verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "none" },
  tools: [],
  egress: { hosts: ["ai.todoist.net"], lan: false, anyNetwork: false },
  credentials: [],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [
    {
      accountId: "mcp.todoist",
      label: "me@example.com",
      identity: "me@example.com",
      owner: { kind: "owner" },
      health: "ready",
      grantedScopes: [],
      missingScopes: [],
      expiresWeekly: false,
      workspaces: ["default"],
      people: false,
      sharing: "personal",
      readOnly: false,
    },
  ],
  health: "ready",
  repairs: [],
  warnings: [],
  ...extra,
});

describe("parsing tavi apps", () => {
  it("sends each action as its apps payload", () => {
    expect(parsed("list", "--needs-you")).toEqual({
      action: "payload",
      payload: { action: "list", workspaceId: "default" },
      needsYou: true,
      format: "text",
    });
    expect(parsed("catalog", "notion", "pages")).toMatchObject({ payload: { action: "catalog", query: "notion pages" } });
    expect(parsed("add", "todoist")).toMatchObject({
      payload: { action: "add", entry: { kind: "preset", id: "todoist" } },
    });
    expect(parsed("add", "todoist-token", "--switch")).toMatchObject({
      payload: { action: "add", entry: { kind: "preset", id: "todoist-token" }, switch: true },
    });
    expect(parsed("add", "todoist")).not.toHaveProperty("payload.switch");
    expect(parsed("add", "io.example/notes@1.2.0", "--option", "npm")).toMatchObject({
      payload: { action: "add", entry: { kind: "registry", name: "io.example/notes", version: "1.2.0", option: "npm" } },
    });
    expect(parsed("show", "todoist", "--workspace", "home")).toMatchObject({
      payload: { action: "show", appId: "todoist", workspaceId: "home" },
    });
    expect(parsed("disconnect", "todoist", "--account", "mcp.todoist2", "--remove")).toMatchObject({
      payload: { action: "disconnect", accountId: "mcp.todoist2", remove: true },
    });
    expect(parsed("activity", "todoist", "--cursor", "abc")).toMatchObject({
      payload: { action: "activity", appId: "todoist", cursor: "abc" },
    });
    // The shared client: its id an argument, its secret only ever from a file.
    expect(parsed("client", "gmail", "--id", "123-web.apps.googleusercontent.com", "--secret-file", "/tmp/secret")).toMatchObject({
      payload: { action: "configure", appId: "gmail", values: { clientId: "123-web.apps.googleusercontent.com" } },
      secretFile: "/tmp/secret",
    });
    expect(() => parsed("client", "gmail")).toThrow(UsageError);
    expect(() => parsed("client", "gmail", "--id", "x", "--secret", "s")).toThrow(UsageError);
    // Or the client file the console downloads, read as it is sent; never with an id as well.
    expect(parsed("client", "gmail", "--file", "/tmp/client_secret.json")).toMatchObject({
      payload: { action: "configure", appId: "gmail", values: {} },
      clientFile: "/tmp/client_secret.json",
    });
    expect(() => parsed("client", "gmail", "--file", "/tmp/c.json", "--id", "x")).toThrow(UsageError);
    expect(parsed("calendar", "gmail", "conn-1", "on")).toMatchObject({
      payload: { action: "calendar", appId: "gmail", accountId: "conn-1", on: true },
    });
    expect(() => parsed("calendar", "gmail", "conn-1", "yes")).toThrow(UsageError);
    expect(parsed("receive", "gmail", "conn-1", "off")).toMatchObject({
      payload: { action: "receive", appId: "gmail", accountId: "conn-1", on: false },
    });
    expect(parsed("permission", "todoist", "mcp.todoist.add-tasks", "block")).toMatchObject({
      payload: { action: "permission", toolId: "mcp.todoist.add-tasks", target: "block" },
    });
    expect(parsed("sharing", "todoist", "mcp.todoist", "shared")).toMatchObject({
      payload: { action: "sharing", accountId: "mcp.todoist", sharing: "shared" },
    });
    expect(parsed("remove", "todoist", "--format", "json")).toMatchObject({ payload: { action: "remove" }, format: "json" });
  });

  it("parses connect's ways back, and test's account", () => {
    expect(parsed("connect", "todoist", "--paste")).toEqual({
      action: "connect",
      appId: "todoist",
      addAccount: false,
      open: true,
      public: false,
      paste: true,
      workspaceId: "default",
      format: "text",
    });
    expect(parsed("connect", "todoist", "--account", "mcp.todoist2", "--port", "8765", "--no-open")).toMatchObject({
      accountId: "mcp.todoist2",
      port: 8765,
      open: false,
    });
    expect(parsed("connect", "todoist", "--add-account", "--public")).toMatchObject({ addAccount: true, public: true });
    expect(parsed("test", "todoist")).toEqual({ action: "test", appId: "todoist", workspaceId: "default", format: "text" });
  });

  it("refuses what it cannot send", () => {
    expect(() => parsed("connect", "x", "--public", "--paste")).toThrow(UsageError);
    expect(() => parsed("connect", "x", "--public", "--port", "8765")).toThrow(/--public comes back to the owner's https address/);
    // A paste comes back to this computer's address, so a client registered at a fixed port keeps it.
    expect(parsed("connect", "x", "--paste", "--port", "8765")).toMatchObject({ paste: true, port: 8765 });
    expect(() => parsed("connect", "x", "--add-account", "--account", "a")).toThrow(UsageError);
    expect(() => parsed("disconnect", "x")).toThrow(/--account/);
    expect(() => parsed("permission", "x", "t", "always")).toThrow(/allow, ask, block/);
    expect(() => parsed("list", "--account", "a")).toThrow(/does not accept --account/);
    expect(() => parsed("nope")).toThrow(/Unknown apps action/);
    expect(() => catalogRefOf("io.example/notes", "npm")).toThrow(/<name>@<version>/);
    expect(() => catalogRefOf("io.example/notes@1.0.0", undefined)).toThrow(/--option/);
    expect(() => catalogRefOf("todoist", "npm")).toThrow(/takes no --option/);
  });
});

describe("what tavi apps prints", () => {
  const lapsed = app({
    appId: "mail",
    name: "Mail",
    health: "needs-sign-in",
    repairs: [
      {
        kind: "sign-in",
        accountId: "mcp.mail",
        title: "Sign in to Mail again",
        detail: "Its sign-in expired.",
        cli: "tavi mcp login mcp.mail",
      },
    ],
  });

  it("lists every app with its fix and command, and --needs-you only those that need you", () => {
    expect(appsListText([app(), lapsed])).toBe(
      "todoist  Todoist: connected (me@example.com)\nmail  Mail: needs sign-in (me@example.com)\n  Sign in to Mail again: Its sign-in expired.\n  tavi mcp login mcp.mail\n",
    );
    expect(appsListText([app(), lapsed], true)).toBe(
      "mail  Mail: needs sign-in (me@example.com)\n  Sign in to Mail again: Its sign-in expired.\n  tavi mcp login mcp.mail\n",
    );
    expect(appsListText([app()], true)).toBe("No app needs you.\n");
  });

  it("says each change in words", () => {
    expect(
      appsAnswerText(
        { action: "add", entry: { kind: "preset", id: "todoist" }, workspaceId: "default" },
        { added: { appId: "todoist", pluginId: "mcp.todoist" } },
      ),
    ).toBe("added todoist (mcp.todoist); connect it: tavi apps connect todoist\n");
    expect(
      appsAnswerText({ action: "sharing", appId: "todoist", accountId: "mcp.todoist", sharing: "personal", workspaceId: "default" }, {}),
    ).toMatch(/Personal/);
    expect(
      appsAnswerText(
        { action: "disconnect", appId: "todoist", accountId: "mcp.todoist", remove: false, workspaceId: "default" },
        { disconnected: { accountId: "mcp.todoist", revoked: false, removed: false } },
      ),
    ).toMatch(/forgotten here/);
    expect(appsAnswerText({ action: "show", appId: "todoist", workspaceId: "default" }, { app: app() })).toContain(
      "calls go to: ai.todoist.net",
    );
  });

  it("says a switch of the way in before what to do with the server it added", () => {
    expect(
      appsAddedText(
        { action: "add", entry: { kind: "preset", id: "todoist-token" }, switch: true, workspaceId: "default" },
        { added: { appId: "todoist-token", pluginId: "mcp.todoist", switched: { from: "todoist", pluginIds: ["mcp.todoist"] } } },
      ),
    ).toMatch(
      /^switched mcp\.todoist from todoist: its old way in was removed; review its tools again once it is set up\nadded todoist-token \(mcp\.todoist\)/,
    );
  });

  it("needs a running owner", async () => {
    const data = directories.create("tavi-apps-cli-");
    const out = capture();
    expect(await main(["apps", "list", "--data-dir", data], { io: out.io })).toBe(EXIT.unavailable);
    expect(out.stderr()).toContain("tavi apps list needs a running owner");
  });

  it("reads a client's secret from its file before asking the owner, and refuses a missing or empty one", async () => {
    const data = directories.create("tavi-apps-cli-");
    const missing = capture();
    expect(
      await main(
        ["apps", "client", "gmail", "--id", "123-web.apps.googleusercontent.com", "--secret-file", join(data, "nope"), "--data-dir", data],
        { io: missing.io },
      ),
    ).not.toBe(EXIT.ok);
    expect(missing.stderr()).toContain("tavi apps client");
    expect(missing.stderr()).not.toContain("needs a running owner");
    writeFileSync(join(data, "empty"), "\n");
    const empty = capture();
    expect(
      await main(
        ["apps", "client", "gmail", "--id", "123-web.apps.googleusercontent.com", "--secret-file", join(data, "empty"), "--data-dir", data],
        { io: empty.io },
      ),
    ).not.toBe(EXIT.ok);
    expect(empty.stderr()).toContain("is empty");
    // A client file read the same way: an empty or oversized one never reaches the owner.
    const emptyFile = capture();
    expect(await main(["apps", "client", "gmail", "--file", join(data, "empty"), "--data-dir", data], { io: emptyFile.io })).not.toBe(
      EXIT.ok,
    );
    expect(emptyFile.stderr()).toContain("is empty");
    writeFileSync(join(data, "large.json"), "x".repeat(9_000));
    const large = capture();
    expect(await main(["apps", "client", "gmail", "--file", join(data, "large.json"), "--data-dir", data], { io: large.io })).not.toBe(
      EXIT.ok,
    );
    expect(large.stderr()).toContain("too large");
    // A readable secret goes on to the owner, which is not running here.
    writeFileSync(join(data, "secret"), "s3cret\n");
    const sent = capture();
    expect(
      await main(
        [
          "apps",
          "client",
          "gmail",
          "--id",
          "123-web.apps.googleusercontent.com",
          "--secret-file",
          join(data, "secret"),
          "--data-dir",
          data,
        ],
        { io: sent.io },
      ),
    ).toBe(EXIT.unavailable);
    expect(sent.stderr()).not.toContain("s3cret");
  });
});

describe("tavi apps connect and test", () => {
  function owner(apps: Readonly<Record<string, ConnectableApp>>) {
    const asked: { command: string; payload: Readonly<Record<string, unknown>> }[] = [];
    const ask: AppsAsk = async <T>(command: "apps" | "mcp" | "channels", payload: Readonly<Record<string, unknown>>): Promise<T> => {
      asked.push({ command, payload });
      if (payload["action"] === "show") {
        const found = apps[String(payload["appId"])];
        if (found === undefined) throw new Error("no such app");
        return { app: found } as T;
      }
      if (payload["action"] === "add") return { added: { appId: "todoist", pluginId: "mcp.todoist2" } } as T;
      if (payload["action"] === "test")
        return { tested: { accountId: payload["accountId"], ...(payload["appId"] === "google-maps" ? { keyChecked: false } : {}) } } as T;
      throw new Error(`not in this fake: ${String(payload["action"])}`);
    };
    const logins: { pluginId: string; options: unknown }[] = [];
    const lines: string[] = [];
    const deps = {
      io: { stdout: (text: string) => lines.push(text), stderr: (text: string) => lines.push(text) },
      login: async (pluginId: string, _ask: AppsAsk, options: unknown) => void logins.push({ pluginId, options }),
    };
    return { ask, asked, logins, lines, deps };
  }
  const oauth = app({
    auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] },
    source: { kind: "mcp", pluginIds: ["mcp.todoist"], preset: "todoist", verified: "tavi-preset", isolation: "remote" },
  });
  const connect = (extra: Record<string, unknown> = {}) => ({
    action: "connect" as const,
    appId: "todoist",
    addAccount: false,
    open: false,
    public: false,
    paste: false,
    workspaceId: "default",
    format: "text" as const,
    ...extra,
  });

  it("signs the app's account in as tavi mcp login does, pasting with a fixed port", async () => {
    const { ask, logins, deps } = owner({ todoist: oauth });
    await runAppsAccountCommand(connect({ paste: true, port: 8765 }), ask, deps);
    expect(logins).toEqual([{ pluginId: "mcp.todoist", options: { open: false, format: "text", port: 8765, paste: true } }]);
  });

  it("adds a preset's next account, then signs that one in; a failed sign-in says how to finish or remove it", async () => {
    const { ask, asked, logins, deps, lines } = owner({ todoist: oauth });
    await runAppsAccountCommand(connect({ addAccount: true, public: true }), ask, deps);
    expect(asked.find((entry) => entry.payload["action"] === "add")?.payload).toEqual({
      action: "add",
      entry: { kind: "preset", id: "todoist" },
      workspaceId: "default",
    });
    expect(logins).toEqual([{ pluginId: "mcp.todoist2", options: { open: false, format: "text", public: true } }]);
    const failing = {
      ...deps,
      login: async () => {
        throw new Error("The sign-in took too long");
      },
    };
    await expect(runAppsAccountCommand(connect({ addAccount: true }), ask, failing)).rejects.toThrow(/took too long/);
    expect(lines.join("")).toContain(
      "mcp.todoist2 was added but is not signed in: sign in with `tavi apps connect todoist --account mcp.todoist2`, or remove it with `tavi apps disconnect todoist --account mcp.todoist2 --remove`",
    );
  });

  it("refuses a channel or an app with no sign-in, and tests the first account", async () => {
    const { ask, deps, lines } = owner({
      gmail: app({
        appId: "gmail",
        name: "Gmail",
        source: { kind: "channel", pluginIds: [], verified: "tavi-preset", isolation: "in-process" },
      }),
      todoist: app(),
    });
    await expect(runAppsAccountCommand(connect({ appId: "gmail" }), ask, deps)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("tavi channels connect"),
    });
    await expect(runAppsAccountCommand(connect(), ask, deps)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("no sign-in"),
    });
    await runAppsAccountCommand({ action: "test", appId: "todoist", workspaceId: "default", format: "text" }, ask, deps);
    expect(lines).toContain("me@example.com answered\n");
  });

  it("says a key whose server lists its tools without it is checked only when a tool is first used", async () => {
    const { ask, deps, lines } = owner({ "google-maps": app({ appId: "google-maps", name: "Google Maps" }) });
    await runAppsAccountCommand({ action: "test", appId: "google-maps", workspaceId: "default", format: "text" }, ask, deps);
    expect(lines).toEqual([
      "me@example.com listed its tools; Google Maps lists them without checking the key, so a wrong key shows only when a tool is first used\n",
    ]);
  });
});
