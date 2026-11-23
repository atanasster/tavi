import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ToolRegistry } from "@tavi/runtime";
import { evaluateGate, type ChatFolder, type InvocationContext, type SandboxPort } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { registerAuthoringTools } from "../../src/features/plugins/authoring-tools.js";
import { folderFileCheck, fsRootResolver } from "../../src/features/folders/fs-tools.js";
import { PLUGIN_AUTHORING_GUIDE } from "../../src/features/plugins/authoring-guide.js";
import { directSandbox as direct } from "../support/direct-sandbox.js";

/** The context an assessor is given with a call; these tools do not read it. */
const assessContext = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };

/** The built-in plugin-authoring skill. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());
const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" };

/** A turn whose chat works in `primary`: the folder `plugins.validate` resolves against. */
function contextIn(primary: string): InvocationContext {
  const managed = `${primary}-managed`;
  const folder: ChatFolder = {
    primary,
    primaryKind: "host",
    managed,
    scratch: join(managed, ".tmp"),
    home: join(managed, ".home"),
    attachments: [],
    revision: 1,
  };
  return { ...context, folder };
}

/** The guide's fenced blocks of one language, in order. */
const blocks = (language: string): string[] =>
  [...PLUGIN_AUTHORING_GUIDE.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1] ?? "");

function setup() {
  const base = realpathSync(directories.create("tavi-authoring-"));
  const root = join(base, "project");
  mkdirSync(join(root, "mods", "guard"), { recursive: true });
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(root, "escape"));
  const registry = new ToolRegistry();
  registerAuthoringTools(registry, { resolve: fsRootResolver({}), validate: { sandbox: direct, platform: "darwin" } });
  const call = async (id: string, input: unknown, as = contextIn(root)) => {
    const tool = registry.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    return tool.handler({ input, context: as, signal: new AbortController().signal });
  };
  return { root, registry, call };
}

describe("plugin authoring tools", () => {
  it("always offers the guide and validate, both read-only", async () => {
    const { registry, call } = setup();
    expect(registry.get("plugins.authoring_guide")?.effect).toBe("read-only");
    expect(registry.get("plugins.validate")?.effect).toBe("read-only");
    expect(await call("plugins.authoring_guide", {})).toMatchObject({
      version: "5",
      guide: expect.stringContaining("# Writing a Tavi plugin"),
    });
  });

  it("asks before validate runs in a turn holding untrusted content, and lets it run otherwise", () => {
    const validate = setup().registry.get("plugins.validate");
    const assessment = validate?.assess?.({ path: "mods/guard" }, assessContext);
    expect(assessment).toMatchObject({ askWhenTainted: true, display: { title: "Validate the plugin in mods/guard" } });
    expect(validate?.assess?.({ path: "mods/guard" }, { ...assessContext, locale: "bg" })).toMatchObject({
      display: { title: "Провери плъгина в mods/guard" },
      reasons: ["пуска register на плъгина в изолирана среда"],
    });
    const verdict = (tainted: boolean) =>
      evaluateGate({
        toolId: "plugins.validate",
        effect: "read-only",
        ...(assessment === undefined ? {} : { assessment }),
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(),
        tainted,
      });
    expect(verdict(false).decision).toBe("allow");
    expect(verdict(true)).toMatchObject({ decision: "ask", allowedScopes: ["once"] });
  });

  it("keeps the guide's example in step with the owner: its manifest and module validate, and its test passes", async () => {
    const { root, call } = setup();
    const folder = join(root, "mods", "guard");
    const [manifest] = blocks("json");
    const [module, test] = blocks("js");
    writeFileSync(join(folder, "tavi-plugin.json"), manifest ?? "");
    writeFileSync(join(folder, "index.mjs"), module ?? "");
    writeFileSync(join(folder, "index.test.mjs"), test ?? "");
    expect(await call("plugins.validate", { path: "mods/guard" })).toMatchObject({
      valid: true,
      checked: "manifest and register",
      folder,
      pluginId: "acme.guard",
      problems: [],
      warnings: [],
      registered: { hooks: [{ event: "tool.check", match: { tools: ["sandbox.run"] } }], commands: ["tally"] },
    });
    const run = spawnSync(process.execPath, ["--test", "index.test.mjs"], { cwd: folder, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it("keeps the guide's heartbeat provider example in step with the owner: it validates, and its test passes", async () => {
    const { root, call } = setup();
    const folder = join(root, "mods", "watch");
    mkdirSync(folder, { recursive: true });
    const [, manifest] = blocks("json");
    const [, , module, test] = blocks("js");
    writeFileSync(join(folder, "tavi-plugin.json"), manifest ?? "");
    writeFileSync(join(folder, "index.mjs"), module ?? "");
    writeFileSync(join(folder, "index.test.mjs"), test ?? "");
    expect(await call("plugins.validate", { path: "mods/watch" })).toMatchObject({
      valid: true,
      checked: "manifest and register",
      pluginId: "acme.watch",
      problems: [],
      warnings: [],
      registered: { heartbeat: { tick: true } },
    });
    const run = spawnSync(process.execPath, ["--test", "index.test.mjs"], { cwd: folder, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it("keeps the guide's memory provider example in step with the owner: it validates, and its test passes", async () => {
    const { root, call } = setup();
    const folder = join(root, "mods", "keywords");
    mkdirSync(folder, { recursive: true });
    const [, , manifest] = blocks("json");
    const [, , , , module, test] = blocks("js");
    writeFileSync(join(folder, "tavi-plugin.json"), manifest ?? "");
    writeFileSync(join(folder, "index.mjs"), module ?? "");
    writeFileSync(join(folder, "index.test.mjs"), test ?? "");
    expect(await call("plugins.validate", { path: "mods/keywords" })).toMatchObject({
      valid: true,
      checked: "manifest and register",
      pluginId: "acme.keywords",
      problems: [],
      warnings: [],
      registered: { memory: { recall: true, capture: false, consolidate: false, sync: false } },
    });
    const run = spawnSync(process.execPath, ["--test", "index.test.mjs"], { cwd: folder, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it("says when only the manifest was checked", async () => {
    const base = realpathSync(directories.create("tavi-authoring-"));
    const registry = new ToolRegistry();
    // macOS and Linux run the register in the sandbox; elsewhere only the manifest is checked.
    registerAuthoringTools(registry, { resolve: fsRootResolver({}), validate: { sandbox: direct, platform: "win32" } });
    writeFileSync(join(base, "tavi-plugin.json"), blocks("json")[0] ?? "");
    writeFileSync(join(base, "index.mjs"), blocks("js")[0] ?? "");
    expect(
      await registry
        .get("plugins.validate")
        ?.handler({ input: { path: "." }, context: contextIn(base), signal: new AbortController().signal }),
    ).toMatchObject({ valid: true, checked: "manifest only", folder: base });
  });

  it("runs one validation at a time, and none for a call cancelled while it waited, going on with the next", async () => {
    const base = realpathSync(directories.create("tavi-authoring-"));
    let running = 0,
      most = 0;
    const slow: SandboxPort = {
      ...direct,
      run: async (policy, command) => {
        running += 1;
        most = Math.max(most, running);
        await delay(30);
        running -= 1;
        return direct.run(policy, command);
      },
    };
    const registry = new ToolRegistry();
    registerAuthoringTools(registry, { resolve: fsRootResolver({}), validate: { sandbox: slow, platform: "darwin" } });
    writeFileSync(join(base, "tavi-plugin.json"), blocks("json")[0] ?? "");
    writeFileSync(join(base, "index.mjs"), blocks("js")[0] ?? "");
    const call = (path: string, signal = new AbortController().signal) =>
      registry.get("plugins.validate")?.handler({ input: { path }, context: contextIn(base), signal });
    // The second is cancelled while it waits its turn: it runs nothing, and the third still runs.
    const waiting = new AbortController();
    const results = Promise.allSettled([call("."), call(".", waiting.signal), call(".")]);
    waiting.abort(new Error("the turn was cancelled"));
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(most).toBe(1);
  });

  it("refuses a folder outside the calling chat's folders", async () => {
    const { call } = setup();
    await expect(call("plugins.validate", { path: "escape" })).rejects.toThrow(/outside your working folder and attached folders/);
  });

  it("resolves the folder against the calling chat's own working folder, and refuses a turn without one", async () => {
    const { root, call } = setup();
    const other = realpathSync(directories.create("tavi-authoring-"));
    // Another chat's folder is out of this one's reach, and the same relative path there names its own.
    await expect(call("plugins.validate", { path: join(other, ".") })).rejects.toThrow(/outside your working folder/);
    expect(await call("plugins.validate", { path: "mods/guard" }, contextIn(other))).toMatchObject({
      folder: join(other, "mods", "guard"),
      valid: false,
    });
    await expect(
      call(
        "plugins.validate",
        { path: "mods/guard" },
        { ...context, folderUnavailable: "This chat's primary folder is gone. Run /folder reset." },
      ),
    ).rejects.toThrow(/\/folder reset/);
    expect(root).not.toBe(other);
  });

  it("reads a plugin in the chat's own folder as fs.read does: a hard-linked file there is refused, never staged (I-isolate)", async () => {
    const base = realpathSync(directories.create("tavi-authoring-"));
    const data = join(base, "data");
    const managed = join(data, "chats", "default", "task-a");
    const plugin = join(managed, "plug");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(base, "elsewhere.mjs"), "export const secret = 1;\n");
    writeFileSync(
      join(plugin, "tavi-plugin.json"),
      JSON.stringify({ id: "acme.linked", version: "1.0.0", name: "Linked", entry: "index.mjs" }),
    );
    linkSync(join(base, "elsewhere.mjs"), join(plugin, "index.mjs"));
    const registry = new ToolRegistry();
    registerAuthoringTools(registry, {
      resolve: fsRootResolver({ dataDirectory: data }),
      checkFile: folderFileCheck({ dataDirectory: data }),
      validate: { sandbox: direct, platform: "linux" },
    });
    const folder: ChatFolder = {
      primary: managed,
      primaryKind: "managed",
      managed,
      scratch: join(managed, ".tmp"),
      home: join(managed, ".home"),
      attachments: [],
      revision: 1,
    };
    const report = await registry
      .get("plugins.validate")
      ?.handler({ input: { path: "plug" }, context: { ...context, folder }, signal: new AbortController().signal });
    expect(report).toMatchObject({ valid: false, problems: [expect.stringMatching(/plugin file index\.mjs has other hard links/)] });
  });
});
