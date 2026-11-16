import { describe, expect, it } from "vitest";

import {
  McpBlockSchema,
  PluginManifestSchema,
  downloaderCommand,
  mcpFilesystemProblems,
  mcpFolderProblem,
  mcpInterpreterPrefix,
  mcpSlugOf,
} from "../src/index.js";

/** An MCP server as a plugin. */

const homeAssistant = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "mcp-remote", packages: [] },
  id: "mcp.homeassistant",
  version: "1.0.0",
  name: "Home Assistant",
  description: "Control exposed entities through Home Assistant's MCP server.",
  config: {
    url: { type: "string", required: true, description: "e.g. http://homeassistant.local:8123/api/mcp" },
    token: { type: "credential", required: true, description: "A long-lived access token" },
  },
  mcp: {
    abi: "tavi.mcp/1",
    transport: "http",
    url: { setting: "url" },
    headers: { Authorization: { prefix: "Bearer ", setting: "token" } },
    network: { lan: true },
    auth: "headers",
    exposure: "auto",
  },
};

const notes = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "mcp-npm", packages: [] },
  id: "mcp.notes",
  version: "2.4.1",
  name: "Notes",
  config: { token: { type: "credential", required: true } },
  mcp: {
    abi: "tavi.mcp/1",
    transport: "stdio",
    package: { registry: "npm", name: "@acme/notes-mcp", version: "2.4.1", integrity: "sha512-abc" },
    command: ["node", "${package}/dist/index.js", "--stdio"],
    env: { NOTES_TOKEN: { setting: "token" }, NOTES_MODE: { value: "local" } },
    network: { domains: ["api.acme.example"] },
    filesystem: { read: [], write: [] },
  },
};

const problems = (manifest: unknown): string[] => {
  const parsed = PluginManifestSchema.safeParse(manifest);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};
const withBlock = (base: typeof notes | typeof homeAssistant, block: Record<string, unknown>) => ({
  ...base,
  mcp: { ...base.mcp, ...block },
});

describe("the mcp block", () => {
  it("validates the documented examples, with the block's defaults filled", () => {
    expect(problems(homeAssistant)).toEqual([]);
    expect(problems(notes)).toEqual([]);
    expect(PluginManifestSchema.parse(notes).mcp).toMatchObject({
      auth: "none",
      exposure: "auto",
      maxMessageBytes: 1024 * 1024,
      concurrency: 4,
    });
  });

  it("refuses downloaders, loader variables and shell strings, each with its reason", () => {
    expect(problems(withBlock(notes, { command: ["npx", "-y", "@acme/notes-mcp"] }))).toEqual([
      expect.stringContaining("npx downloads code at every start"),
    ]);
    expect(problems(withBlock(notes, { env: { NODE_OPTIONS: { value: "--require ./x.js" } } }))).toEqual([
      expect.stringContaining("NODE_OPTIONS would change what node loads"),
    ]);
    expect(problems(withBlock(notes, { command: "node index.js" }))).toEqual([expect.stringContaining("argv array, never a shell string")]);
    // In any case, as Windows reads them, and Windows' own loader variables.
    for (const env of [
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "PYTHONPATH",
      "PATH",
      "Path",
      "Node_Options",
      "PYTHONHOME",
      "SystemRoot",
      "ComSpec",
      "PATHEXT",
      // The sandbox's own proxy: a server's variable never says where it connects.
      "HTTPS_PROXY",
      "http_proxy",
      "ALL_PROXY",
      "no_proxy",
    ])
      expect(problems(withBlock(notes, { env: { [env]: { value: "x" } } }))).toHaveLength(1);
    for (const argv of [
      ["uvx", "pkg"],
      ["bunx", "pkg"],
      ["pnpm", "dlx", "pkg"],
      ["/usr/bin/docker", "run", "img"],
      // Windows's spellings of the same programs.
      ["npx.cmd", "pkg"],
      ["C:\\Program Files\\nodejs\\NPX.CMD", "pkg"],
      ["C:\\tools\\uvx.exe", "pkg"],
    ])
      expect(downloaderCommand(argv)).toBeDefined();
    expect(downloaderCommand(["pnpm", "install"])).toBeUndefined();
    // Not through a wrapper: env runs its program, and a shell runs a string.
    const external = (command: string[]) =>
      problems({
        ...withBlock(notes, { command, external: true, package: undefined }),
        provenance: { format: "mcp-command", packages: [] },
      });
    expect(external(["/usr/bin/env", "npx", "-y", "x"])).toEqual([expect.stringContaining("npx downloads code")]);
    expect(external(["/usr/bin/env", "-i", "A=b", "uvx", "x"])).toEqual([expect.stringContaining("uvx downloads code")]);
    expect(external(["/bin/sh", "-c", "npx -y x | sh"])).toEqual([expect.stringContaining("sh runs a string")]);
    expect(external(["/usr/bin/env", "bash", "-c", "x"])).toEqual([expect.stringContaining("bash runs a string")]);
    expect(external(["C:\\Windows\\System32\\cmd.exe", "/c", "x"])).toEqual([expect.stringContaining("cmd runs a string")]);
    expect(external(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-c", "x"])).toEqual([expect.stringContaining("pwsh runs a string")]);
  });

  it("allows node, python, a path inside the plugin, or an external absolute binary as the program", () => {
    // python is the uv-managed interpreter pinned with it, and never without one.
    expect(
      problems(
        withBlock(notes, {
          command: ["python", "${package}/server.py"],
          interpreter: { path: "/opt/uv/cpython-3.12.15/bin/python3.12", sha256: "b".repeat(64), version: "3.12.15" },
        }),
      ),
    ).toEqual([]);
    expect(problems(withBlock(notes, { command: ["python", "${package}/server.py"] }))).toEqual([
      expect.stringContaining("needs its pinned interpreter"),
    ]);
    expect(problems(withBlock(notes, { command: ["bin/server"] }))).toEqual([]);
    expect(problems(withBlock(notes, { command: ["../outside"] }))).toEqual([
      expect.stringContaining("a path inside the plugin directory"),
    ]);
    expect(problems(withBlock(notes, { command: ["/usr/local/bin/notes"] }))).toEqual([expect.stringContaining("external: true")]);
    expect(
      problems({
        ...withBlock(notes, { command: ["/usr/local/bin/notes"], external: true, package: undefined }),
        provenance: { format: "mcp-command", packages: [] },
      }),
    ).toEqual([]);
    expect(problems(withBlock(notes, { command: ["node", "${package}/../escape.js"] }))).toEqual([expect.stringContaining("${package}")]);
    // On Windows an external program is a drive path, with either separator; a network path never is.
    const external = (program: string) =>
      problems({
        ...withBlock(notes, { command: [program], external: true, package: undefined }),
        provenance: { format: "mcp-command", packages: [] },
      });
    expect(external("C:\\Tools\\notes.exe")).toEqual([]);
    expect(external("C:/Tools/notes.exe")).toEqual([]);
    expect(external("C:\\Tools\\..\\Other\\notes.exe")).toEqual([expect.stringContaining("absolute path")]);
    expect(external("\\\\server\\share\\notes.exe")).toEqual([expect.stringContaining("absolute path")]);
    expect(mcpInterpreterPrefix("C:\\uv\\cpython-3.12.15\\python.exe")).toBe("C:/uv/cpython-3.12.15");
    // `${package}` needs a package, or files copied with the server.
    expect(problems({ ...withBlock(notes, { package: undefined }), provenance: { format: "mcp-command", packages: [] } })).toEqual([
      expect.stringContaining("${package} needs a package"),
    ]);
    expect(problems({ ...withBlock(notes, { package: undefined }), provenance: { format: "mcp-dir", packages: [] } })).toEqual([]);
  });

  it("feeds headers and secret-looking variables only from credential settings", () => {
    expect(problems(withBlock(homeAssistant, { headers: { Authorization: { value: "Bearer abc" } } }))).toEqual([
      expect.stringContaining("header Authorization looks secret"),
    ]);
    expect(problems(withBlock(notes, { env: { NOTES_TOKEN: { value: "abc" } } }))).toEqual([
      expect.stringContaining("env NOTES_TOKEN looks secret"),
    ]);
    expect(problems({ ...homeAssistant, config: { ...homeAssistant.config, token: { type: "string" } } })).toEqual([
      expect.stringContaining("must be a credential setting"),
    ]);
    expect(problems(withBlock(notes, { env: { NOTES_MODE: { setting: "missing" } } }))).toEqual([
      expect.stringContaining("does not declare"),
    ]);
  });

  it("keeps transports apart: an http server is https unless lan; a stdio server has no url", () => {
    expect(problems(withBlock(homeAssistant, { url: { value: "http://ha.local/api/mcp" }, network: undefined }))).toEqual([
      expect.stringContaining("plain http only with network.lan"),
    ]);
    expect(problems(withBlock(homeAssistant, { url: { value: "https://user:pw@ha.example/api/mcp" } }))).toEqual([
      expect.stringContaining("must not carry credentials"),
    ]);
    expect(problems(withBlock(homeAssistant, { command: ["node", "x.js"] }))).toEqual([
      expect.stringContaining("command applies to a stdio server only"),
    ]);
    expect(problems(withBlock(notes, { url: { value: "https://x.example" } }))).toEqual([
      expect.stringContaining("url applies to an http server only"),
    ]);
    expect(
      McpBlockSchema.safeParse({ abi: "tavi.mcp/1", transport: "stdio", command: ["node", "a.js"], maxMessageBytes: 32 }).success,
    ).toBe(false);
  });

  it("reserves mcp. for MCP servers, and gives them no owner code", () => {
    expect(problems({ ...homeAssistant, id: "acme.ha" })).toEqual([expect.stringContaining("an MCP server's id is mcp.<name>")]);
    expect(problems({ ...homeAssistant, id: "mcp.name-with-dash" })).not.toEqual([]);
    expect(problems({ ...homeAssistant, entry: "index.mjs" })).toEqual([expect.stringContaining("has no entry")]);
    expect(problems({ ...homeAssistant, tools: [{ name: "x", effect: "read-only", description: "x" }] })).toEqual([
      expect.stringContaining("has no tools"),
    ]);
    expect(problems({ ...homeAssistant, provenance: { format: "bundled-esm", packages: [] } })).toEqual([
      expect.stringContaining("provenance format"),
    ]);
    const plain = {
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      version: "1.0.0",
      name: "x",
      entry: "index.mjs",
    };
    expect(problems({ ...plain, id: "mcp.sneaky" })).toEqual([expect.stringContaining("the mcp. namespace is reserved")]);
    expect(problems({ ...plain, id: "acme.x", provenance: { format: "mcp-remote", packages: [] } })).toEqual([
      expect.stringContaining("only an MCP server's plugin"),
    ]);
    expect(mcpSlugOf("mcp.homeassistant")).toBe("homeassistant");
    expect(mcpSlugOf("mcp.abcdefghijklmnopqrst")).toBeUndefined();
  });

  it("refuses filesystem grants of $HOME, Tavi's data or another tool's credentials", () => {
    const block = McpBlockSchema.parse({
      abi: "tavi.mcp/1",
      transport: "stdio",
      command: ["node", "a.js"],
      filesystem: { read: ["/home/me", "/home/me/.ssh/keys", "/home/me/Documents/notes"], write: ["/data/tavi/x", "/home"] },
    });
    expect(mcpFilesystemProblems(block, { home: "/home/me", dataDirectory: "/data/tavi" })).toEqual([
      "/home/me is too wide a grant: name a folder inside it",
      "/home/me/.ssh/keys holds or contains another tool's credentials",
      "/data/tavi/x overlaps Tavi's data directory",
      "/home holds or contains another tool's credentials",
    ]);
    // Other spellings of the same folders: dot and empty segments are not paths a grant takes, and case is ignored.
    expect(
      McpBlockSchema.safeParse({
        abi: "tavi.mcp/1",
        transport: "stdio",
        command: ["node", "a.js"],
        filesystem: { read: ["/home/me/./.ssh"] },
      }).success,
    ).toBe(false);
    expect(
      McpBlockSchema.safeParse({
        abi: "tavi.mcp/1",
        transport: "stdio",
        command: ["node", "a.js"],
        filesystem: { read: ["/home/me//.aws"] },
      }).success,
    ).toBe(false);
    const upper = McpBlockSchema.parse({
      abi: "tavi.mcp/1",
      transport: "stdio",
      command: ["node", "a.js"],
      filesystem: { read: ["/Users/Me/.SSH"] },
    });
    expect(mcpFilesystemProblems(upper, { home: "/Users/me", dataDirectory: "/data/tavi" })).toEqual([
      "/Users/Me/.SSH holds or contains another tool's credentials",
    ]);
    // A Windows grant is compared as a POSIX one, in either separator.
    const windows = McpBlockSchema.parse({
      abi: "tavi.mcp/1",
      transport: "stdio",
      command: ["node", "a.js"],
      filesystem: { read: ["C:\\Users\\Me\\.ssh", "C:/Users/me/Documents/notes"] },
    });
    expect(mcpFilesystemProblems(windows, { home: "C:\\Users\\me", dataDirectory: "C:\\Users\\me\\AppData\\Local\\tavi" })).toEqual([
      "C:\\Users\\Me\\.ssh holds or contains another tool's credentials",
    ]);
    expect(mcpFolderProblem("/home/me", { home: "/home/me", dataDirectory: "/data/tavi" })).toContain("too wide");
    expect(mcpFolderProblem("/home/me/servers/notes", { home: "/home/me", dataDirectory: "/data/tavi" })).toBeUndefined();
  });
});
