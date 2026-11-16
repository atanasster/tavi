import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchLike } from "@modelcontextprotocol/client";
import { McpPayloadSchema } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { mcpCommand, operatorActor } from "../../src/server/config-commands.js";
import { guardedFetch } from "../../src/features/mcp/fetch.js";
import { EXIT, main } from "../../src/main.js";
import { writeMcpPluginDirectory } from "../../src/features/mcp/add.js";
import {
  MCP_REGISTRY_DEFAULT,
  ServerJsonSchema,
  downloadBundle,
  registryBase,
  registryForms,
  registryServer,
  searchRegistry,
  suggestedSlug,
  type ServerJson,
} from "../../src/features/mcp/registry.js";
import { capture } from "../support/attached-owner.js";
import { zip } from "../support/zip.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The MCP Registry: a cached page of it, read, mapped to install forms, and installed through the form. */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp");
const RAW = join(FIXTURES, "raw-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

/** The raw server as a bundle, the file the cached page's `io.github.example/raw` names. */
const BUNDLE = zip([
  {
    name: "manifest.json",
    data: JSON.stringify({
      manifest_version: "0.3",
      name: "raw",
      version: "1.2.0",
      server: { type: "node", entry_point: "server/raw.mjs", mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs"] } },
    }),
  },
  { name: "server/raw.mjs", data: readFileSync(RAW), mode: 0o100644 },
]);
const BUNDLE_SHA256 = createHash("sha256").update(BUNDLE).digest("hex");
const PAGE = JSON.parse(readFileSync(join(FIXTURES, "registry", "servers.json"), "utf8").replace("{{RAW_SHA256}}", BUNDLE_SHA256)) as {
  readonly servers: readonly { readonly server: unknown }[];
};
const server = (name: string): ServerJson =>
  ServerJsonSchema.parse(PAGE.servers.find((item) => (item.server as { name?: string }).name === name)?.server);

/**
 * The registry and the bundle's host as the cached fixture answers them: the search page, each server at a version,
 * and the bundle behind a GitHub-style redirect. Every request is recorded.
 */
function cachedRegistry(): { readonly fetch: FetchLike; readonly requested: string[] } {
  const requested: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    requested.push(url.href);
    if (url.host === "registry.example") {
      if (url.pathname === "/v0.1/servers") return Response.json(PAGE);
      const one = /^\/v0\.1\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
      const found =
        one === null
          ? undefined
          : PAGE.servers.find((item) => (item.server as { name?: string }).name === decodeURIComponent(one[1] as string));
      return found === undefined ? new Response("{}", { status: 404 }) : Response.json(found);
    }
    if (url.host === "github.com") {
      expect((init as RequestInit | undefined)?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://objects.example/raw.mcpb" } });
    }
    if (url.host === "objects.example") return new Response(BUNDLE);
    return new Response("not found", { status: 404 });
  };
  return { fetch, requested };
}

describe("reading the registry", () => {
  it("searches the latest versions a page at a time, leaving out an entry it cannot read", async () => {
    const { fetch, requested } = cachedRegistry();
    const page = await searchRegistry(fetch, "https://registry.example/", "notes");
    expect(requested[0]).toBe("https://registry.example/v0.1/servers?search=notes&version=latest&limit=30");
    expect(page.entries.map((entry) => entry.name)).toEqual([
      "io.github.example/notes",
      "com.example/calendar",
      "io.github.example/raw",
      "io.github.example/dotnet",
    ]);
    expect(page.next).toBe("io.github.example/dotnet:0.3.0");
    await searchRegistry(fetch, "https://registry.example", "", page.next);
    expect(requested[1]).toBe("https://registry.example/v0.1/servers?version=latest&limit=30&cursor=io.github.example%2Fdotnet%3A0.3.0");
  });

  it("labels each entry, and cleans its words: an escape and a direction override never reach a person", async () => {
    const page = await searchRegistry(cachedRegistry().fetch, "https://registry.example", "");
    const [notes, calendar, raw, dotnet] = page.entries;
    expect(notes).toMatchObject({
      title: "Notes",
      description: "Search your notes. Trusted by everyone",
      labels: ["installable", "oci-unsupported"],
      slug: "notes",
      websiteUrl: "https://notes.example",
      repositoryUrl: "https://github.com/example/notes",
    });
    expect(notes?.options.map((option) => [option.key, option.summary])).toEqual([
      ["npm", "@example/notes-mcp@1.4.0"],
      ["pypi", "notes-mcp==1.4.0"],
    ]);
    expect(notes?.options[0]).toMatchObject({
      credentials: ["notes_key"],
      settings: [],
      notes: ["its runtime arguments are not used: Tavi runs the package itself"],
    });
    expect(notes?.unsupported).toEqual(["oci package docker.io/example/notes: Tavi does not run this kind of package"]);
    expect(calendar).toMatchObject({
      labels: ["installable", "remote"],
      slug: "calendar",
      options: [{ key: "remote", kind: "remote", summary: "https://mcp.calendar.example/mcp", credentials: ["authorization"] }],
    });
    expect(calendar?.unsupported).toEqual(["remote https://mcp.calendar.example/sse: an SSE server; Tavi reaches Streamable HTTP only"]);
    expect(raw).toMatchObject({ labels: ["installable"], options: [{ key: "mcpb", kind: "mcpb" }] });
    expect(dotnet).toMatchObject({ labels: ["nuget-unsupported", "cargo-unsupported"], options: [] });
  });

  it("maps inputs: a secret a credential, a static value a literal, an optional one with none left out, a templated header a prefixed credential", () => {
    const notes = registryForms(server("io.github.example/notes")).forms.get("npm");
    expect(notes).toMatchObject({
      form: { kind: "npm", spec: "@example/notes-mcp@1.4.0", args: ["--root", "/notes"] },
      env: ["NOTES_KEY=@notes_key", "NOTES_MODE=read"],
      credentials: ["notes_key"],
    });
    expect(registryForms(server("com.example/calendar")).forms.get("remote")).toMatchObject({
      form: { kind: "url", url: "https://mcp.calendar.example/mcp", headers: ["Authorization=Bearer @authorization"] },
    });
    // A placeholder whose variable is secret is a credential, whatever the input's own flag says.
    const variable = registryForms({
      name: "io.github.example/db",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "db",
          version: "1.0.0",
          environmentVariables: [{ name: "DB_URL", value: "{conn}", variables: { conn: { isSecret: true } } }],
        },
      ],
    }).forms.get("npm");
    expect(variable).toMatchObject({ env: ["DB_URL=@db_url"], credentials: ["db_url"] });
  });

  it("leaves out what Tavi cannot run as listed, saying why", () => {
    const base: ServerJson = { name: "io.github.example/x", version: "1.0.0" };
    const why = (extra: Partial<ServerJson>) => registryForms({ ...base, ...extra }).unsupported;
    expect(why({ packages: [{ registryType: "npm", identifier: "x", version: "^1.0.0" }] })[0]).toMatch(/version \^1\.0\.0 is not exact/);
    expect(
      why({ packages: [{ registryType: "npm", registryBaseUrl: "https://npm.corp.example", identifier: "x", version: "1.0.0" }] })[0],
    ).toMatch(/not on the public npm registry/);
    expect(
      why({
        packages: [
          {
            registryType: "npm",
            identifier: "x",
            version: "1.0.0",
            transport: { type: "streamable-http", url: "http://localhost:8080/mcp" },
          },
        ],
      })[0],
    ).toMatch(/serves streamable-http itself/);
    expect(
      why({
        packages: [
          {
            registryType: "npm",
            identifier: "x",
            version: "1.0.0",
            packageArguments: [{ type: "positional", valueHint: "workspace", isRequired: true }],
          },
        ],
      })[0],
    ).toMatch(/needs a value for workspace/);
    expect(
      why({
        packages: [
          {
            registryType: "npm",
            identifier: "x",
            version: "1.0.0",
            packageArguments: [{ type: "named", name: "--token", isSecret: true }],
          },
        ],
      })[0],
    ).toMatch(/takes the secret --token as an argument/);
    expect(why({ packages: [{ registryType: "mcpb", identifier: "https://x.example/x.mcpb", version: "1.0.0" }] })[0]).toMatch(
      /carries no fileSha256/,
    );
    expect(why({ remotes: [{ type: "streamable-http", url: "https://{tenant}.example/mcp" }] })[0]).toMatch(/its address has variables/);
    expect(why({ remotes: [{ type: "streamable-http", url: "http://plain.example/mcp" }] })[0]).toMatch(/not https/);
    // A literal `--env` or `--header` would read as a setting, and a setting run into other text, are refused.
    expect(
      why({
        packages: [{ registryType: "npm", identifier: "x", version: "1.0.0", environmentVariables: [{ name: "SCOPE", value: "@acme" }] }],
      })[0],
    ).toMatch(/SCOPE's value reads as a setting/);
    expect(
      why({
        remotes: [
          { type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "X-Key", value: "token={key}", isSecret: true }] },
        ],
      })[0],
    ).toMatch(/X-Key mixes a setting into other text/);
    expect(
      why({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "X-Team", value: "Team @ops" }] }] })[0],
    ).toMatch(/X-Team's value reads as a credential/);
    expect(suggestedSlug("io.github.acme/GitHub-MCP-Server")).toBe("github");
    expect(suggestedSlug("io.github.acme/123")).toBe("server");
  });

  it("reads one server at its version, and refuses an answer for another", async () => {
    const { fetch, requested } = cachedRegistry();
    expect((await registryServer(fetch, "https://registry.example", "com.example/calendar", "2.0.0")).version).toBe("2.0.0");
    expect(requested[0]).toBe("https://registry.example/v0.1/servers/com.example%2Fcalendar/versions/2.0.0");
    await expect(registryServer(fetch, "https://registry.example", "com.example/nope", "latest")).rejects.toThrow(/no such server/);
    const lying: FetchLike = async () => Response.json({ server: { name: "com.example/other", version: "1.0.0" } });
    await expect(registryServer(lying, "https://registry.example", "com.example/calendar", "latest")).rejects.toThrow(
      /answered for com.example\/other/,
    );
    await expect(registryServer(fetch, "https://registry.example", "com.example/calendar", "1.0.0")).rejects.toThrow(
      /version 2\.0\.0, not 1\.0\.0/,
    );
  });

  it("downloads a bundle through its redirects, over https only, and only the one its entry names", async () => {
    const { fetch } = cachedRegistry();
    expect(
      (await downloadBundle(fetch, "https://github.com/example/raw/releases/download/v1.2.0/raw.mcpb", BUNDLE_SHA256)).equals(BUNDLE),
    ).toBe(true);
    await expect(downloadBundle(fetch, "https://github.com/example/raw/releases/download/v1.2.0/raw.mcpb", "0".repeat(64))).rejects.toThrow(
      /its SHA-256 differs/,
    );
    await expect(downloadBundle(fetch, "http://objects.example/raw.mcpb", BUNDLE_SHA256)).rejects.toThrow(/over https only/);
    // Each hop goes through the guard again: a redirect to a private address is refused before it is dialed.
    const guarded = guardedFetch({ lan: false, manualRedirects: true, resolve: async () => ["10.0.0.5"] });
    const hops: FetchLike = async (input, init) =>
      new URL(String(input)).host === "start.example"
        ? new Response(null, { status: 302, headers: { location: "https://inside.example/raw.mcpb" } })
        : await guarded(input, init);
    await expect(downloadBundle(hops, "https://start.example/raw.mcpb", BUNDLE_SHA256)).rejects.toThrow(
      /inside\.example resolved to 10\.0\.0\.5 is a private address/,
    );
    const loop: FetchLike = async (input) => new Response(null, { status: 302, headers: { location: String(input) } });
    await expect(downloadBundle(loop, "https://loop.example/a", BUNDLE_SHA256)).rejects.toThrow(/redirected more than 5 times/);
  });

  it("takes a registry address over https only, and the official one by default", () => {
    expect(MCP_REGISTRY_DEFAULT).toBe("https://registry.modelcontextprotocol.io");
    expect(registryBase("https://registry.example/")).toBe("https://registry.example");
    expect(() => registryBase("http://registry.example")).toThrow(/over https/);
    expect(() => registryBase("https://user:pw@registry.example")).toThrow(/no credentials/);
  });
});

describe("installing through the form", () => {
  it("parses search, registry and add --registry, and the owner's payload takes the registry form", () => {
    expect(parseArgs(["mcp", "search", "notes", "app"]).mcp).toMatchObject({
      action: "payload",
      payload: { action: "search", query: "notes app" },
    });
    expect(parseArgs(["mcp", "registry", "--default"]).mcp).toMatchObject({
      action: "payload",
      payload: { action: "registry", reset: true },
    });
    expect(parseArgs(["mcp", "add", "cal", "--registry", "com.example/calendar@2.0.0", "--option", "remote"]).mcp).toMatchObject({
      action: "add",
      form: { kind: "registry", name: "com.example/calendar", version: "2.0.0", option: "remote" },
    });
    expect(parseArgs(["mcp", "add", "cal", "--registry", "com.example/calendar", "--option", "remote"]).mcp).toMatchObject({
      form: { version: "latest" },
    });
    expect(() => parseArgs(["mcp", "add", "cal", "--registry", "com.example/calendar"])).toThrow(/needs --option/);
    expect(
      McpPayloadSchema.parse({
        action: "add",
        slug: "cal",
        form: { kind: "registry", name: "com.example/calendar", version: "2.0.0", option: "remote" },
      }),
    ).toMatchObject({ form: { kind: "registry" } });
    expect(
      McpPayloadSchema.safeParse({ action: "add", slug: "cal", form: { kind: "registry", name: "x", version: "1", option: "docker" } })
        .success,
    ).toBe(false);
  });

  it("a remote entry becomes a remote server, its secret header a credential; the listing's words go on its notes", async () => {
    const data = directories.create("tavi-mcp-registry-");
    const written = await writeMcpPluginDirectory(
      { slug: "cal", form: { kind: "registry", name: "com.example/calendar", version: "2.0.0", option: "remote" } },
      { dataDirectory: data, registry: { fetch: cachedRegistry().fetch, base: "https://registry.example" } },
    );
    expect(written.manifest).toMatchObject({
      id: "mcp.cal",
      version: "2.0.0",
      name: "cal",
      description: "A hosted calendar.",
      config: { authorization: { type: "credential", required: true } },
      mcp: {
        transport: "http",
        url: { value: "https://mcp.calendar.example/mcp" },
        headers: { Authorization: { setting: "authorization", prefix: "Bearer " } },
        auth: "headers",
      },
    });
    expect(written.notes[0]).toBe(
      "from the MCP Registry: com.example/calendar 2.0.0 (remote) — the listing is its publisher's word, not a reason to trust it",
    );
    const installed = await tavi(["plugins", "install", written.directory, "--data-dir", data]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    expect((await tavi(["mcp", "show", "mcp.cal", "--data-dir", data])).stdout).toContain(
      "every call sends its arguments to https://mcp.calendar.example/mcp",
    );
    await expect(
      writeMcpPluginDirectory(
        { slug: "cal", form: { kind: "registry", name: "com.example/calendar", version: "2.0.0", option: "npm" } },
        { dataDirectory: data, registry: { fetch: cachedRegistry().fetch, base: "https://registry.example" } },
      ),
    ).rejects.toThrow(/has no way to add it as npm; it has remote/);
  });

  it.skipIf(process.platform !== "darwin")(
    "a bundle entry is downloaded, checked against its SHA-256, installed, and probed in its sandbox",
    async () => {
      const data = directories.create("tavi-mcp-registry-");
      const { fetch, requested } = cachedRegistry();
      const written = await writeMcpPluginDirectory(
        { slug: "raw", form: { kind: "registry", name: "io.github.example/raw", version: "1.2.0", option: "mcpb" } },
        { dataDirectory: data, registry: { fetch, base: "https://registry.example" } },
      );
      expect(requested).toEqual([
        "https://registry.example/v0.1/servers/io.github.example%2Fraw/versions/1.2.0",
        "https://github.com/example/raw/releases/download/v1.2.0/raw.mcpb",
        "https://objects.example/raw.mcpb",
      ]);
      expect(written.manifest).toMatchObject({
        id: "mcp.raw",
        version: "1.2.0",
        provenance: { format: "mcp-mcpb" },
        mcp: { command: ["node", "${package}/server/raw.mjs"] },
      });
      expect(written.notes).toContain("unsigned");
      expect((await tavi(["plugins", "install", written.directory, "--data-dir", data])).code).toBe(EXIT.ok);
      const probed = await tavi(["mcp", "probe", "mcp.raw", "--data-dir", data]);
      expect(probed.code, probed.stderr).toBe(EXIT.ok);
      expect(probed.stdout).toContain("mcp.raw@1.2.0 (proposed), sandbox: srt");
      expect(probed.stdout).toMatch(/echo → mcp\.raw\.echo \[pending\]/);
    },
    120_000,
  );
});

describe("the registry searched", () => {
  it("is the official one until the CLI names another; a page reads it and cannot change it", async () => {
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directories.create("tavi-mcp-registry-"), {
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      }),
      { modelOverride: createFixtureModel({ turns: [] }) },
    );
    runtimes.push(runtime);
    const ask = async (payload: { readonly url?: string; readonly reset?: boolean }, fromPage = false) =>
      await mcpCommand(runtime, { action: "registry", reset: false, ...payload }, operatorActor(fromPage));
    expect(await ask({})).toMatchObject({
      ok: true,
      result: { registry: { url: "https://registry.modelcontextprotocol.io", official: true } },
    });
    expect(await ask({ url: "https://registry.example" }, true)).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(await ask({ reset: true }, true)).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(await ask({ url: "https://registry.example/" })).toMatchObject({
      ok: true,
      result: { registry: { url: "https://registry.example", official: false } },
    });
    expect(await ask({}, true)).toMatchObject({ ok: true, result: { registry: { url: "https://registry.example" } } });
    expect(await ask({ url: "http://registry.example" })).toMatchObject({ ok: false });
    expect(await ask({ reset: true })).toMatchObject({
      ok: true,
      result: { registry: { url: "https://registry.modelcontextprotocol.io", official: true } },
    });
  }, 60_000);
});
