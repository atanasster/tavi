import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { taintModeOf as runtimeTaintModeOf } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import {
  checkTemplate,
  cleanupOnSignal,
  isPrivateDirectory,
  privateCopy,
  runnerData,
  taintModeOf,
  templateHoldings,
  templateRefusal,
  templateTaintMode,
  templateUnusable,
  withTemplateCopies,
} from "../evals/template.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/** The live evals' template data directory (evals/template.ts): what it may hold, its private copies, and their cleanup. */

describe("a live eval's template data directory", () => {
  it("refuses a template that holds more than model connections", async () => {
    expect(templateRefusal({ chats: 0, reminders: 0 })).toBeUndefined();
    expect(templateRefusal({ chats: 2, "messaging connections": 1, reminders: 0 })).toMatch(
      /holds 2 chats, 1 messaging connections: make a dedicated one/,
    );
    const scratch = temp.create("eval-template-check-");
    const template = join(scratch, "template");
    expect(templateUnusable(template)).toBe(`no template data directory at ${template}`);
    mkdirSync(template);
    expect(templateUnusable(template)).toBeUndefined();
    await expect(checkTemplate(template, scratch)).resolves.toBeUndefined();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(template, "tavi.sqlite"));
    db.exec(
      "CREATE TABLE tavi_model_connections (id TEXT); INSERT INTO tavi_model_connections VALUES ('openrouter'); CREATE TABLE tavi_reminders (id TEXT); INSERT INTO tavi_reminders VALUES ('r1'); CREATE TABLE tavi_heartbeats (enabled INTEGER); INSERT INTO tavi_heartbeats VALUES (0);",
    );
    db.close();
    await expect(checkTemplate(template, scratch)).rejects.toThrow("the template data directory holds 1 heartbeats, 1 reminders");
    expect(readdirSync(scratch)).toEqual(["template"]);
    mkdirSync(join(template, "runtime"));
    writeFileSync(join(template, "runtime", "ipc.json"), "{}");
    expect(templateUnusable(template)).toMatch(/`tavi serve` owns the template data directory/);
  });

  it("holds a template to an allowlist: connections, catalog, roles, defaults, credentials and what a fresh directory seeds", async () => {
    const scratch = temp.create("eval-template-allowlist-");
    const template = join(scratch, "template");
    mkdirSync(join(template, "credentials"), { recursive: true });
    writeFileSync(join(template, "credentials", "openrouter.json"), "{}");
    mkdirSync(join(template, "logs"));
    mkdirSync(join(template, "runtime"));
    mkdirSync(join(template, "plugins"));
    writeFileSync(join(template, "owner.lock"), "");
    writeFileSync(join(template, "provider-bindings.key"), "k");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(template, "tavi.sqlite"));
    // What `tavi serve` leaves in a fresh data directory, and a connection set up as the README says.
    db.exec(`
      CREATE TABLE tavi_meta (key TEXT, value TEXT); INSERT INTO tavi_meta VALUES ('profile.format', 'tavi-1');
      CREATE TABLE tavi_schema_migrations (migration_id TEXT); INSERT INTO tavi_schema_migrations VALUES ('0001_baseline');
      CREATE VIRTUAL TABLE tavi_memory_fts USING fts5(body);
      CREATE TABLE tavi_tool_rule_seeds (workspace_id TEXT, rule_id TEXT); INSERT INTO tavi_tool_rule_seeds VALUES ('default', 'seeded-reminders');
      CREATE TABLE tavi_tool_rules (workspace_id TEXT, rule_id TEXT, rule_json TEXT);
      INSERT INTO tavi_tool_rules VALUES ('default', 'seeded-reminders', '{"createdBy":"tavi"}');
      CREATE TABLE tavi_workspace_settings (workspace_id TEXT, settings_json TEXT); INSERT INTO tavi_workspace_settings VALUES ('default', '{"homeChat":true,"timezone":"Europe/Lisbon","securityTaint":"observe"}');
      CREATE TABLE tavi_model_connections (id TEXT); INSERT INTO tavi_model_connections VALUES ('openrouter');
      CREATE TABLE tavi_model_catalog (id TEXT); INSERT INTO tavi_model_catalog VALUES ('m');
      CREATE TABLE tavi_model_roles (id TEXT); INSERT INTO tavi_model_roles VALUES ('embedding');
      CREATE TABLE tavi_model_workspace_defaults (id TEXT); INSERT INTO tavi_model_workspace_defaults VALUES ('default');
      CREATE TABLE tavi_provider_attempts (data TEXT); INSERT INTO tavi_provider_attempts VALUES ('{}');
      CREATE TABLE tavi_agent_definitions (id TEXT); CREATE TABLE tavi_projects (id TEXT); CREATE TABLE tavi_plugin_versions (id TEXT); CREATE TABLE tavi_plugin_settings (id TEXT);
      CREATE TABLE tavi_onboarding (id INTEGER, provider_id TEXT, first_seen_at TEXT, completed_at TEXT, dismissed_at TEXT, dismissed_flow_version INTEGER, flow_version INTEGER);
      INSERT INTO tavi_onboarding (id) VALUES (1);
    `);
    db.close();
    await expect(checkTemplate(template, scratch)).resolves.toBeUndefined();
    await expect(templateTaintMode(template)).resolves.toBe("observe");
    await expect(templateTaintMode(template, "enforce")).resolves.toBe("enforce");
    expect(taintModeOf({}, undefined)).toBe("enforce");
    // The template's copy (evals run under plain node, unbuilt) answers as the runtime's does.
    const modes = [undefined, "off", "observe", "enforce"] as const;
    for (const setting of modes) {
      for (const owner of modes) {
        const settings = setting === undefined ? {} : { securityTaint: setting };
        expect(taintModeOf(settings, owner), `${setting}/${owner}`).toBe(runtimeTaintModeOf(settings, owner));
      }
    }
    // Everything else that matters is refused, each named.
    const more = new DatabaseSync(join(template, "tavi.sqlite"));
    more.exec(`
      INSERT INTO tavi_tool_rules VALUES ('default', 'r-allow-shell', '{"createdBy":"operator:cli"}');
      INSERT INTO tavi_tool_rule_seeds VALUES ('default', 'r-edited');
      INSERT INTO tavi_tool_rules VALUES ('default', 'r-edited', '{"createdBy":"operator:cli"}');
      UPDATE tavi_workspace_settings SET settings_json = '{"homeChat":true,"memory":{"retrieval":"hybrid"},"uiRoles":{}}';
      INSERT INTO tavi_agent_definitions VALUES ('a'); INSERT INTO tavi_projects VALUES ('p');
      INSERT INTO tavi_plugin_versions VALUES ('x'); INSERT INTO tavi_plugin_settings VALUES ('x');
      CREATE TABLE tavi_checkpoint_notes (id TEXT); INSERT INTO tavi_checkpoint_notes VALUES ('n');
      UPDATE tavi_onboarding SET provider_id = 'openrouter';
    `);
    more.close();
    mkdirSync(join(template, "plugins", "x"));
    writeFileSync(join(template, "projects.json"), "[]");
    const holdings = await templateHoldings(template);
    expect(holdings).toEqual({
      "installed plugins (plugins/)": 1,
      "collector projects (projects.json)": 1,
      "agent definitions": 1,
      "installed plugin versions": 1,
      "plugin settings": 1,
      projects: 1,
      "rows of tavi_checkpoint_notes": 1,
      "tool rules beyond the seeded ones": 2,
      "`memory` settings": 1,
      "`uiRoles` settings": 1,
      "onboarding progress": 1,
    });
    await expect(checkTemplate(template, scratch)).rejects.toThrow(/2 tool rules beyond the seeded ones.*1 `memory` settings/);
  });

  it("on SIGINT or SIGTERM stops the commands and owners, removes the scratch copies and exits", async () => {
    const scratch = temp.create("eval-template-signal-");
    writeFileSync(join(scratch, "credentials.json"), "{}");
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const events: string[] = [];
    let exited!: () => void;
    const exitedOnce = new Promise<void>((done) => {
      exited = done;
    });
    const host = {
      on: (signal: NodeJS.Signals, listener: () => void) => listeners.set(signal, listener),
      off: (signal: NodeJS.Signals) => listeners.delete(signal),
      exit: (code: number) => {
        exits.push(code);
        exited();
      },
    };
    const remove = cleanupOnSignal({
      scratch: [scratch],
      log: () => undefined,
      host,
      commands: [{ kill: (signal) => events.push(`command ${signal}`) }],
      owners: [{ stop: async () => void events.push("owner stopped") }],
    });
    expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    listeners.get("SIGTERM")?.();
    listeners.get("SIGINT")?.();
    await exitedOnce;
    expect(events).toEqual(["command SIGTERM", "owner stopped"]);
    expect(exits).toEqual([143]);
    expect(existsSync(scratch)).toBe(false);
    remove();
    expect(listeners.size).toBe(0);
  });

  it("copies a data directory private (0700), whatever the copy's umask made it", () => {
    const scratch = temp.create("eval-template-copy-");
    const template = join(scratch, "template");
    mkdirSync(join(template, "credentials"), { recursive: true });
    writeFileSync(join(template, "tavi.sqlite"), "");
    chmodSync(template, 0o755);
    chmodSync(join(template, "credentials"), 0o755);
    const copied = privateCopy(template, join(scratch, "world-tavi"));
    expect(isPrivateDirectory(copied)).toBe(true);
    expect(isPrivateDirectory(join(copied, "credentials"))).toBe(true);
  });
  it("runs in copies of a template, or a data directory opted into, never the default one", () => {
    expect(() => runnerData(undefined, undefined, "evals/x/README.md")).toThrow(
      /pass --template <dir> \(see evals\/x\/README.md\).*never runs in the default data directory/,
    );
    expect(() => runnerData("a", "b", "r")).toThrow("pass --template or --data-dir, not both");
    expect(runnerData("t", undefined, "r")).toEqual({ template: resolve("t") });
    expect(runnerData(undefined, "d", "r")).toEqual({ dataDir: resolve("d") });
  });

  it("gives each run a private copy of a checked template, and removes them all when the runs end", async () => {
    const root = temp.create("eval-template-copies-");
    const template = join(root, "template");
    mkdirSync(join(template, "credentials"), { recursive: true });
    writeFileSync(join(template, "credentials", "openrouter.json"), "{}");
    let scratch = "";
    const copied = await withTemplateCopies(template, { prefix: "eval-template-run-", log: () => undefined }, async (copy) => {
      const first = copy("r1");
      scratch = dirname(first);
      expect(isPrivateDirectory(scratch)).toBe(true);
      expect(isPrivateDirectory(first)).toBe(true);
      expect(existsSync(join(first, "credentials", "openrouter.json"))).toBe(true);
      return [first, copy("r2")];
    });
    expect(copied.map((path) => path.slice(scratch.length + 1))).toEqual(["r1", "r2"]);
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(template)).toEqual(["credentials"]);
    // A failing run still removes its copies; a refused template makes none.
    await expect(
      withTemplateCopies(template, { prefix: "eval-template-run-" }, async (copy) => {
        scratch = dirname(copy("r1"));
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(existsSync(scratch)).toBe(false);
    writeFileSync(join(template, "projects.json"), "[]");
    await expect(withTemplateCopies(template, { prefix: "eval-template-run-" }, async () => "ran")).rejects.toThrow(
      /holds 1 collector projects/,
    );
    await expect(withTemplateCopies(join(root, "missing"), { prefix: "eval-template-run-" }, async () => "ran")).rejects.toThrow(
      "no template data directory at",
    );
  });
});
