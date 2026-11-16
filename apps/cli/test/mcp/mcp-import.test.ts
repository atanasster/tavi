import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories, fakeFetch } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { mcpAddManifest, type McpAddForm } from "../../src/features/mcp/add.js";
import {
  npmResolver,
  parseJsonc,
  planMcpImport,
  pypiResolver,
  readMcpServers,
  slugFor,
  type NpmResolver,
  type PypiResolver,
} from "../../src/features/mcp/import.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { capture } from "../support/attached-owner.js";

/** `tavi mcp import`: proposes, pins, moves secrets, approves nothing. */

const directories = temporaryDirectories({ prefix: "tavi-mcp-import-" });
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

/** The registry's answer, without the network: `latest` is 2.1.0, an exact version is itself. */
const resolve: NpmResolver = async (name, tag) => {
  if (name === "ghost") throw new Error("npm has no ghost@latest (HTTP 404)");
  return tag === "latest" ? "2.1.0" : tag;
};
/** PyPI's answer, without the network: the latest is 2026.10.10, an exact version is itself, `ghostpy` does not exist. */
const resolvePypi: PypiResolver = async (name, version) => {
  if (name === "ghostpy") throw new Error("PyPI has no ghostpy (HTTP 404)");
  return version ?? "2026.10.10";
};
const plan = (file: unknown, taken: readonly string[] = []) =>
  planMcpImport(JSON.stringify(file), { taken: new Set(taken), resolve, resolvePypi });

describe("reading another client's file", () => {
  it("reads Claude Desktop's and Cursor's mcpServers, ~/.claude.json's projects, and VS Code's servers with comments", () => {
    expect(readMcpServers(JSON.stringify({ mcpServers: { a: { command: "x" } } })).entries.map((entry) => entry.name)).toEqual(["a"]);
    const claude = readMcpServers(
      JSON.stringify({
        mcpServers: { a: { command: "x" } },
        projects: { "/p": { mcpServers: { b: { url: "https://b.example/mcp" }, a: { command: "y" } } } },
      }),
    );
    expect(claude.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(claude.skipped).toEqual([{ name: "a", reason: "named again later in the file; the first is proposed" }]);
    const vscode = readMcpServers(`{
      // VS Code's mcp.json
      "inputs": [{ "id": "key", "type": "promptString", "password": true }],
      "servers": { "gh": { "type": "http", "url": "https://gh.example/mcp/", /* trailing */ }, },
    }`);
    expect(vscode.entries).toEqual([{ name: "gh", entry: { type: "http", url: "https://gh.example/mcp/" } }]);
    expect(readMcpServers(JSON.stringify({ mcp: { servers: { s: { command: "/bin/s" } } } })).entries.map((entry) => entry.name)).toEqual([
      "s",
    ]);
    expect(() => readMcpServers("{}")).toThrow(/holds no mcpServers/);
    expect(() => readMcpServers("not json")).toThrow(/not JSON/);
  });

  it("keeps // and a trailing comma inside a string", () => {
    expect(parseJsonc(`{"url": "https://a.example/x,]", // c\n "b": "//not a comment",}`)).toEqual({
      url: "https://a.example/x,]",
      b: "//not a comment",
    });
  });

  it("names a server from the file's name", () => {
    expect(slugFor("GitHub-Server")).toBe("githubserver");
    expect(slugFor("2fa tool")).toBe("fatool");
    expect(slugFor("a-very-long-server-name-indeed")).toHaveLength(19);
    expect(slugFor("—")).toBeUndefined();
  });
});

describe("the proposal for each server", () => {
  it("pins npx -y to the exact version npm resolves, keeping the server's argv", async () => {
    const { proposals } = await plan({
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@acme/memory-mcp", "--store", "x"] },
        pinned: { command: "npx", args: ["@acme/time@1.4.0"] },
      },
    });
    expect(proposals[0]).toMatchObject({
      slug: "memory",
      args: ["--npm", "@acme/memory-mcp@2.1.0", "--", "--store", "x"],
      notes: ["npx ran @acme/memory-mcp@latest; pinned to 2.1.0"],
    });
    expect(proposals[1]).toMatchObject({ slug: "pinned", args: ["--npm", "@acme/time@1.4.0"], notes: [] });
  });

  it("moves literal secrets into credentials — a secret-looking variable, an Authorization header — and keeps the rest literal", async () => {
    const { proposals } = await plan({
      mcpServers: {
        gh: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_secret", LOG_LEVEL: "info" } },
        docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer sk-live", "X-Team": "blue" } },
      },
    });
    expect(proposals[0]).toMatchObject({
      args: ["--npm", "gh-mcp@2.1.0", "--env", "GITHUB_TOKEN=@GITHUB_TOKEN", "--env", "LOG_LEVEL=info"],
      secrets: [{ setting: "GITHUB_TOKEN", value: "ghp_secret" }],
    });
    expect(proposals[1]).toMatchObject({
      args: ["--url", "https://docs.example/mcp", "--header", "Authorization=Bearer @Authorization", "--header", "X-Team=blue"],
      secrets: [{ setting: "Authorization", value: "sk-live" }],
    });
    // What add writes from it: the secret a credential setting, never a literal.
    const parsed = parseArgs(["mcp", "add", "docs", ...(proposals[1]?.args ?? [])]) as { mcp: { form: McpAddForm } };
    const manifest = mcpAddManifest({ slug: "docs", form: parsed.mcp.form });
    expect(manifest.config).toEqual({ Authorization: expect.objectContaining({ type: "credential" }) });
    expect(JSON.stringify(manifest)).not.toContain("sk-live");
  });

  it("moves a secret found by its value into a credential, whatever its variable is called, and skips a secret in an argument", async () => {
    const { proposals, skipped } = await plan({
      mcpServers: {
        db: { command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://app:hunter2@db.example/app", PORT: "5432" } },
        pgargs: { command: "npx", args: ["-y", "pg-mcp", "postgresql://app:hunter2@db.example/app"] },
        keyed: { command: "npx", args: ["-y", "x-mcp", "--api-key", "abc123"] },
        inline: { command: "npx", args: ["-y", "x-mcp", "--token=abc123"] },
        token: { command: "/usr/local/bin/tool", args: ["ghp_0123456789abcdefghijABCDEFGHIJ"] },
        // Not secrets: flags that merely contain a secret-ish word, and a path to a secret.
        plain: {
          command: "/usr/local/bin/tool",
          args: ["--author", "me", "--oauth-mode", "pkce", "--session-dir", "/tmp/s", "--token-file", "/etc/tok"],
        },
      },
    });
    expect(proposals.map((proposal) => proposal.name)).toContain("plain");
    expect(proposals[0]).toMatchObject({
      args: ["--npm", "pg-mcp@2.1.0", "--env", "DATABASE_URL=@DATABASE_URL", "--secret", "DATABASE_URL", "--env", "PORT=5432"],
      secrets: [{ setting: "DATABASE_URL", value: "postgres://app:hunter2@db.example/app" }],
    });
    // What add writes from it: the setting a credential, the password nowhere.
    const parsed = parseArgs(["mcp", "add", "db", ...(proposals[0]?.args ?? [])]) as {
      mcp: { form: McpAddForm; env: readonly string[]; secrets?: readonly string[] };
    };
    const manifest = mcpAddManifest(
      {
        slug: "db",
        form: parsed.mcp.form,
        env: parsed.mcp.env,
        ...(parsed.mcp.secrets === undefined ? {} : { credentials: parsed.mcp.secrets }),
      },
      undefined,
      {
        name: "pg-mcp",
        version: "2.1.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        entry: "index.js",
        license: "MIT",
        files: 1,
        native: [],
        deprecated: [],
      },
    );
    expect(manifest.config["DATABASE_URL"]).toMatchObject({ type: "credential" });
    expect(JSON.stringify(manifest)).not.toContain("hunter2");
    expect(skipped.map((entry) => [entry.name, entry.reason.replace(/, which would.*$/, "")])).toEqual([
      ["pgargs", "argument 3 carries a URL with a password"],
      ["keyed", "its --api-key argument carries a secret"],
      ["inline", "its --token argument carries a secret"],
      ["token", "argument 1 carries an API token"],
    ]);
  });

  it("turns a placeholder (${input:…}, ${env:…}) into a setting left to set", async () => {
    const { proposals } = await plan({
      servers: {
        api: { type: "http", url: "https://api.example/mcp", headers: { "X-API-Key": "${input:key}" } },
        tool: { command: "/usr/local/bin/tool", env: { API_TOKEN: "${env:API_TOKEN}" } },
      },
    });
    expect(proposals[0]).toMatchObject({
      args: ["--url", "https://api.example/mcp", "--header", "X-API-Key=@X_API_Key"],
      secrets: [],
      unset: ["X_API_Key"],
    });
    expect(proposals[1]).toMatchObject({
      args: ["--command", "/usr/local/bin/tool", "--env", "API_TOKEN=@API_TOKEN"],
      unset: ["API_TOKEN"],
    });
  });

  it("pins uvx to the exact version PyPI names, keeping the server's argv", async () => {
    const { proposals, skipped } = await plan({
      mcpServers: {
        time: { command: "uvx", args: ["mcp-server-time", "--local-timezone=UTC"] },
        pinned: { command: "uvx", args: ["mcp-server-fetch@2025.4.7"] },
        git: { command: "uvx", args: ["--from", "git+https://example.com/x", "srv"] },
        gone: { command: "uvx", args: ["ghostpy"] },
      },
    });
    expect(proposals[0]).toMatchObject({
      slug: "time",
      args: ["--pypi", "mcp-server-time==2026.10.10", "--", "--local-timezone=UTC"],
      notes: ["uvx ran the latest mcp-server-time; pinned to 2026.10.10"],
    });
    expect(proposals[1]).toMatchObject({ slug: "pinned", args: ["--pypi", "mcp-server-fetch==2025.4.7"], notes: [] });
    expect(Object.fromEntries(skipped.map((skip) => [skip.name, skip.reason]))).toEqual({
      git: "uvx --from cannot be rewritten; add the server by hand with --pypi",
      gone: "PyPI has no ghostpy (HTTP 404)",
    });
  });

  it("asks PyPI's JSON API for the latest or the exact version, refusing a redirect", async () => {
    const asked: string[] = [];
    const fake = fakeFetch(async (url, init) => {
      asked.push(`${url} ${String(init?.redirect)}`);
      return new Response(JSON.stringify({ info: { version: "1.2.3" } }), { status: 200 });
    });
    expect(await pypiResolver({ fetch: fake })("mcp-server-time", undefined)).toBe("1.2.3");
    // Any other spelling is asked by its normal name: PyPI would redirect it, and a redirect is refused.
    expect(await pypiResolver({ fetch: fake })("MCP_Server.Time", "1.2.3")).toBe("1.2.3");
    expect(asked).toEqual(["https://pypi.org/pypi/mcp-server-time/json error", "https://pypi.org/pypi/mcp-server-time/1.2.3/json error"]);
  });

  it("reads a large project's release list, which runs past the bound other answers are read under", async () => {
    const releases = Object.fromEntries(Array.from({ length: 6_000 }, (_, index) => [`1.0.${index}`, [{ filename: "x".repeat(900) }]]));
    const body = JSON.stringify({ info: { version: "1.0.5999" }, releases });
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
    const fake = fakeFetch(async () => new Response(body, { status: 200 }));
    expect(await pypiResolver({ fetch: fake })("botocore", undefined)).toBe("1.0.5999");
    // Building and parsing ~5 MB of JSON: its own deadline, so a loaded machine does not fail it.
  }, 30_000);

  it("lists and skips what it cannot rewrite, saying why", async () => {
    const { proposals, skipped } = await plan(
      {
        mcpServers: {
          box: { command: "docker", args: ["run", "-i", "acme/mcp"] },
          dlx: { command: "pnpm", args: ["dlx", "acme-mcp"] },
          local: { command: "node", args: ["./server.js"] },
          shell: { command: "/bin/sh", args: ["-c", "acme-mcp"] },
          old: { type: "sse", url: "https://old.example/sse" },
          lan: { url: "http://192.168.1.5:8123/api/mcp" },
          range: { command: "npx", args: ["-y", "acme@^1.2.0"] },
          ghost: { command: "npx", args: ["-y", "ghost"] },
          taken: { command: "/bin/true" },
          local8: { url: "http://localhost:8080/mcp" },
          keyed: { url: "https://hosted.example/mcp?api_key=k-123" },
          mixedHeader: { url: "https://h.example/mcp", headers: { Authorization: "Token ${env:T}" } },
          mixedEnv: { command: "/bin/s", env: { ENDPOINT: "https://${env:HOST}/x" } },
        },
      },
      ["taken"],
    );
    expect(proposals).toEqual([]);
    const reasons = Object.fromEntries(skipped.map((skip) => [skip.name, skip.reason]));
    expect(reasons["box"]).toMatch(/docker runs containers/);
    expect(reasons["dlx"]).toMatch(/pnpm dlx downloads code/);
    expect(reasons["local"]).toMatch(/add it by hand with --dir/);
    expect(reasons["shell"]).toMatch(/sh runs a string/);
    expect(reasons["old"]).toMatch(/SSE server/);
    expect(reasons["lan"]).toMatch(/plain http to 192\.168\.1\.5:8123.*--lan/);
    expect(reasons["range"]).toMatch(/is a range/);
    expect(reasons["ghost"]).toMatch(/npm has no ghost/);
    expect(reasons["taken"]).toMatch(/a server named taken already exists/);
    expect(reasons["local8"]).toMatch(/plain http to localhost:8080.*--lan/);
    expect(reasons["keyed"]).toMatch(/its url carries a secret \(api_key\)/);
    expect(reasons["mixedHeader"]).toMatch(/its header Authorization mixes a placeholder/);
    expect(reasons["mixedEnv"]).toMatch(/its variable ENDPOINT mixes a placeholder/);
    expect(JSON.stringify(skipped)).not.toContain("k-123");
  });

  it("names an env setting the way add reads one, whatever the variable's name", async () => {
    const { proposals } = await plan({ mcpServers: { op: { command: "/bin/op", env: { _TOKEN: "t" } } } });
    expect(proposals[0]).toMatchObject({
      args: ["--command", "/bin/op", "--env", "_TOKEN=@TOKEN"],
      secrets: [{ setting: "TOKEN", value: "t" }],
    });
    const parsed = parseArgs(["mcp", "add", "op", ...(proposals[0]?.args ?? [])]) as { mcp: { form: McpAddForm; env: readonly string[] } };
    expect(mcpAddManifest({ slug: "op", form: parsed.mcp.form, env: parsed.mcp.env }).config).toEqual({
      TOKEN: expect.objectContaining({ type: "credential" }),
    });
  });

  it("names the same slug only once", async () => {
    const { proposals, skipped } = await plan({ mcpServers: { "my-tool": { command: "/bin/a" }, mytool: { command: "/bin/b" } } });
    expect(proposals.map((proposal) => proposal.slug)).toEqual(["mytool"]);
    expect(skipped).toEqual([{ name: "mytool", reason: "a server named mytool already exists; add it by hand with another name" }]);
  });

  it("resolves a tag through the registry, refusing a redirect and a non-exact answer", async () => {
    const asked: string[] = [];
    const fake = fakeFetch(async (url, init) => {
      asked.push(`${url} ${String(init?.redirect)}`);
      return new Response(JSON.stringify({ version: url.endsWith("/bad/latest") ? "1.x" : "3.0.1" }), { status: 200 });
    });
    const resolver = npmResolver({ registry: "https://registry.example/", fetch: fake });
    expect(await resolver("@acme/memory-mcp", "latest")).toBe("3.0.1");
    expect(asked).toEqual(["https://registry.example/@acme%2fmemory-mcp/latest error"]);
    await expect(resolver("bad", "latest")).rejects.toThrow(/no exact version/);
  });
});

describe("tavi mcp import, offline", () => {
  it("adds each server as a proposed version, stores its secrets as credentials, leaves the file unchanged, and approves nothing", async () => {
    const data = directories.create();
    const at = ["--data-dir", data];
    const file = join(directories.create(), "claude_desktop_config.json");
    const source = JSON.stringify(
      {
        mcpServers: {
          docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer sk-imported" } },
          time: { command: "uvx", args: ["--from", "git+https://example.com/time", "time"] },
        },
      },
      null,
      2,
    );
    writeFileSync(file, source);
    const dry = await tavi(["mcp", "import", file, "--dry-run", ...at]);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.stdout).toContain(
      "would add mcp.docs: tavi mcp add docs --url https://docs.example/mcp --header Authorization=Bearer @Authorization",
    );
    expect(dry.stdout).toContain("secrets moved into credentials: Authorization");
    expect(dry.stdout).toContain("skipped time: uvx --from cannot be rewritten");
    expect(dry.stdout).not.toContain("sk-imported");
    expect((await tavi(["plugins", "list", "--format", "json", ...at])).stdout).not.toContain("mcp.docs");

    const imported = await tavi(["mcp", "import", file, "--no-probe", ...at]);
    expect(imported.code).toBe(EXIT.ok);
    expect(imported.stdout).toContain("docs → mcp.docs");
    expect(imported.stdout).toContain("added mcp.docs@1.0.0 (proposed)");
    expect(imported.stdout).toContain("1 proposed, 1 skipped; nothing is approved");
    expect(imported.stdout + imported.stderr).not.toContain("sk-imported");
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(await createLocalCredentialStore(data).getSecret("plugins.mcp.docs.Authorization")).toBe("sk-imported");
    const shown = JSON.parse((await tavi(["plugins", "show", "mcp.docs", "--format", "json", ...at])).stdout) as {
      config: Record<string, unknown>;
      versions: { reviewState: string }[];
    };
    expect(shown.config).toEqual({ Authorization: "plugins.mcp.docs.Authorization" });
    expect(shown.versions.map((version) => version.reviewState)).toEqual(["proposed"]);
    // No secret is left in a staging file.
    expect(readdirSync(join(data, "mcp")).includes(".import")).toBe(false);

    // Again: the name is taken now, so nothing is added twice.
    const again = await tavi(["mcp", "import", file, "--no-probe", "--format", "json", ...at]);
    expect(JSON.parse(again.stdout)).toMatchObject({
      added: [],
      skipped: expect.arrayContaining([{ name: "docs", reason: "a server named docs already exists; add it by hand with another name" }]),
    });
  });

  it("tavi mcp line takes its text or --clear, never both or neither", () => {
    expect(parseArgs(["mcp", "line", "mcp.docs", "Company", "docs"])).toMatchObject({
      mcp: { action: "payload", payload: { action: "line", pluginId: "mcp.docs", text: "Company docs" } },
    });
    expect(parseArgs(["mcp", "line", "mcp.docs", "--clear"])).toMatchObject({ mcp: { payload: { action: "line", pluginId: "mcp.docs" } } });
    expect(() => parseArgs(["mcp", "line", "mcp.docs", "text", "--clear"])).toThrow(/takes its text, or --clear/);
    expect(() => parseArgs(["mcp", "line", "mcp.docs"])).toThrow(/takes its text, or --clear/);
    expect(() => parseArgs(["mcp", "line", "docs", "text"])).toThrow(/needs a server id/);
  });

  it("parses its options", () => {
    expect(parseArgs(["mcp", "import", "a.json", "--dry-run"])).toMatchObject({
      command: "mcp",
      mcp: { action: "import", file: "a.json", dryRun: true, probe: true },
    });
    expect(() => parseArgs(["mcp", "import"])).toThrow(/needs exactly one file/);
    expect(() => parseArgs(["mcp", "import", "a.json", "--lan"])).toThrow(/does not accept --lan/);
  });
});
