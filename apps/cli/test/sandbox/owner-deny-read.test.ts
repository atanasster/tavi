import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfinedLaunch, ConfinementPort, PluginManifest, PluginWorkerLaunch, PluginWorkerServices } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { libraryRoots } from "@tavi/plugin-video";

import { parseArgs } from "../../src/cli/parse.js";
import { serverPolicy, stdioLaunch } from "../../src/features/mcp/launcher.js";
import { pdfSandbox } from "../../src/features/pdf/host.js";
import { readRootProblem } from "../../src/features/sandbox/parse.js";
import {
  createOwnerPluginIsolation,
  denyingRead,
  offlineOwnerConfinement,
  ownerConfinement,
  ownerDenyRead,
  readOwnerReadRoots,
  saveOwnerReadRoots,
} from "../../src/features/sandbox/host.js";
import { videoLibraryDenyRead, videoSandbox } from "../../src/features/video/host.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";

/** Every confined child is denied the folders the owner was given for chats, outside `$HOME` too. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** A confinement that keeps each launch and stops there. */
function recording(): { readonly port: ConfinementPort; readonly launches: ConfinedLaunch[] } {
  const launches: ConfinedLaunch[] = [];
  return {
    launches,
    port: {
      wrap: (launch) => {
        launches.push(launch);
        throw new Error("recorded");
      },
    },
  };
}

function roots(): { readonly data: string; readonly fsRoot: string; readonly devPlugin: string; readonly sandboxRead: string } {
  const base = realpathSync(directories.create("tavi-owner-deny-"));
  const made = {
    data: join(base, "data"),
    fsRoot: join(base, "srv-work"),
    devPlugin: join(base, "dev-plugin"),
    sandboxRead: join(base, "reference"),
  };
  for (const path of Object.values(made)) mkdirSync(path, { recursive: true });
  return made;
}

describe("the owner's read denies", () => {
  it("name home, the data directory and every folder given for chats, resolved", () => {
    const { data, fsRoot, devPlugin, sandboxRead } = roots();
    expect(
      ownerDenyRead(
        { dataDirectory: data, fsRoots: [`${fsRoot}/`, fsRoot], devPlugins: [devPlugin], sandboxRead: [sandboxRead] },
        homedir(),
        undefined,
      ),
    ).toEqual([homedir(), data, fsRoot, devPlugin, sandboxRead]);
  });

  it("name the Windows drives and WSL's interop folder on WSL, and nowhere else", () => {
    const { data } = roots();
    const wslRoots = () => ["/mnt", "/run/WSL", "/c"];
    expect(ownerDenyRead({ dataDirectory: data }, homedir(), 2, wslRoots)).toEqual([homedir(), data, "/mnt", "/run/WSL", "/c"]);
    expect(ownerDenyRead({ dataDirectory: data }, homedir(), undefined)).toEqual([homedir(), data]);
  });

  it("name the credentials systemd hands a unit ($CREDENTIALS_DIRECTORY), which its own user could otherwise read", () => {
    const { data } = roots();
    const credentials = "/run/credentials/tavi.service";
    expect(ownerDenyRead({ dataDirectory: data }, homedir(), undefined, () => [], credentials)).toEqual([homedir(), data, credentials]);
    // Read from the environment by default: an owner started by systemd has it set.
    const before = process.env["CREDENTIALS_DIRECTORY"];
    process.env["CREDENTIALS_DIRECTORY"] = credentials;
    try {
      expect(ownerDenyRead({ dataDirectory: data }, homedir(), undefined)).toContain(credentials);
    } finally {
      if (before === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = before;
    }
    expect(ownerDenyRead({ dataDirectory: data }, homedir(), undefined, () => [], "")).toEqual([homedir(), data]);
  });

  it("deny a plugin worker every --fs-root, --dev-plugin and --sandbox-read folder", async () => {
    const { data, fsRoot, devPlugin, sandboxRead } = roots();
    const confinement = recording();
    const isolation = createOwnerPluginIsolation({
      dataDirectory: data,
      fsRoots: [fsRoot],
      devPlugins: [devPlugin],
      sandboxRead: [sandboxRead],
      confinement: confinement.port,
    });
    const home = join(data, "plugins", "acme", "home");
    const launch = {
      pluginId: "acme",
      version: "1.0.0",
      contentHash: "x",
      directory: join(data, "plugins", "acme", "1.0.0"),
      entryPath: "index.mjs",
      manifest: { id: "acme", tools: [] } as unknown as PluginManifest,
      config: {},
      maskedSecrets: {},
      home,
    } satisfies PluginWorkerLaunch;
    await expect(isolation.start(launch, {} as PluginWorkerServices)).rejects.toThrow("recorded");
    expect(confinement.launches[0]?.policy.denyRead).toEqual(expect.arrayContaining([homedir(), data, fsRoot, devPlugin, sandboxRead]));
  });

  it("reach an MCP server's, a PDF child's and a video child's written srt policy through the owner's confinement", () => {
    const { data, fsRoot, devPlugin, sandboxRead } = roots();
    const confinement = denyingRead(
      ownerConfinement(),
      ownerDenyRead({ dataDirectory: data, fsRoots: [fsRoot], devPlugins: [devPlugin], sandboxRead: [sandboxRead] }),
    );
    const denied = (args: readonly string[]): readonly string[] => {
      const file = args.find((arg) => arg.endsWith(".json"));
      if (file === undefined) throw new Error(`no settings file in ${args.join(" ")}`);
      return (JSON.parse(readFileSync(file, "utf8")) as { readonly filesystem: { readonly denyRead: readonly string[] } }).filesystem
        .denyRead;
    };
    const pdf = pdfSandbox(data, confinement, { platform: "darwin" });
    if (pdf.kind !== "wrapped") throw new Error("expected srt on macOS");
    const parser = pdf.wrap({ argv: ["node", "child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf"] });
    if ("refused" in parser) throw new Error("expected srt on macOS");
    expect(denied(parser.args)).toEqual(expect.arrayContaining([fsRoot, devPlugin, sandboxRead]));
    const video = videoSandbox(data, confinement, { platform: "darwin" });
    const runDirectory = join(data, "video", "run");
    mkdirSync(runDirectory, { recursive: true });
    const wrapped =
      video.kind === "wrapped"
        ? video.wrap({ argv: ["ffprobe"], env: {}, runDirectory, readRoots: [], limits: { memoryBytes: 1, processes: 1 } } as never)
        : undefined;
    if (wrapped === undefined || "refused" in wrapped) throw new Error("expected srt on macOS");
    expect(denied(wrapped.args)).toEqual(expect.arrayContaining([fsRoot, devPlugin, sandboxRead]));
    const manifest = {
      id: "acme-mcp",
      version: "1.0.0",
      provenance: { format: "tavi" },
      mcp: { transport: "stdio", command: ["node", "server.mjs"] },
    } as unknown as PluginManifest;
    const server = stdioLaunch(
      { pluginId: "acme-mcp", manifest, pluginDirectory: join(data, "plugins", "acme-mcp"), sandboxState: "srt", env: {} },
      { dataDirectory: data, confinement },
    );
    expect(denied(server.args)).toEqual(expect.arrayContaining([fsRoot, devPlugin, sandboxRead]));
  });

  it("keep a server's approved filesystem.read inside an fs root open in its written policy", () => {
    const { data, fsRoot } = roots();
    const confinement = denyingRead(ownerConfinement(), ownerDenyRead({ dataDirectory: data, fsRoots: [fsRoot] }));
    const granted = join(fsRoot, "docs");
    mkdirSync(granted);
    const manifest = {
      id: "acme-mcp",
      version: "1.0.0",
      provenance: { format: "tavi" },
      mcp: { transport: "stdio", command: ["node", "server.mjs"], filesystem: { read: [granted] } },
    } as unknown as PluginManifest;
    const server = stdioLaunch(
      { pluginId: "acme-mcp", manifest, pluginDirectory: join(data, "plugins", "acme-mcp"), sandboxState: "srt", env: {} },
      { dataDirectory: data, confinement },
    );
    const file = server.args.find((arg) => arg.endsWith(".json")) ?? "";
    const settings = JSON.parse(readFileSync(file, "utf8")) as {
      readonly filesystem: { readonly denyRead: readonly string[]; readonly allowRead: readonly string[] };
    };
    expect(settings.filesystem.denyRead).toContain(fsRoot);
    expect(settings.filesystem.allowRead).toContain(granted);
  });

  it("deny the usual places outside $HOME to a command run without serve on a data directory with no record", () => {
    const data = directories.create("tavi-unrecorded-");
    const manifest = {
      id: "acme-mcp",
      version: "1.0.0",
      provenance: { format: "tavi" },
      mcp: { transport: "stdio", command: ["node", "server.mjs"] },
    } as unknown as PluginManifest;
    const server = stdioLaunch(
      { pluginId: "acme-mcp", manifest, pluginDirectory: join(data, "plugins", "acme-mcp"), sandboxState: "srt", env: {} },
      { dataDirectory: data, confinement: offlineOwnerConfinement(data) },
    );
    const settings = JSON.parse(readFileSync(server.args.find((arg) => arg.endsWith(".json")) ?? "", "utf8")) as {
      readonly filesystem: { readonly denyRead: readonly string[] };
    };
    expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining(["/Volumes", "/mnt", "/srv"]));
  });

  it("are recorded by serve (0600) and denied by a command run without it", () => {
    const { data, fsRoot, devPlugin, sandboxRead } = roots();
    expect(readOwnerReadRoots(data)).toEqual({ dataDirectory: data });
    saveOwnerReadRoots({ dataDirectory: data, fsRoots: [fsRoot], devPlugins: [devPlugin], sandboxRead: [sandboxRead] });
    const file = join(data, "sandbox", "read-roots.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOwnerReadRoots(data)).toEqual({
      dataDirectory: data,
      fsRoots: [fsRoot],
      devPlugins: [devPlugin],
      sandboxRead: [sandboxRead],
    });
    const manifest = {
      id: "acme-mcp",
      version: "1.0.0",
      provenance: { format: "tavi" },
      mcp: { transport: "stdio", command: ["node", "server.mjs"] },
    } as unknown as PluginManifest;
    const server = stdioLaunch(
      { pluginId: "acme-mcp", manifest, pluginDirectory: join(data, "plugins", "acme-mcp"), sandboxState: "srt", env: {} },
      { dataDirectory: data, confinement: offlineOwnerConfinement(data) },
    );
    const settings = JSON.parse(readFileSync(server.args.find((arg) => arg.endsWith(".json")) ?? "", "utf8")) as {
      readonly filesystem: { readonly denyRead: readonly string[] };
    };
    expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining([fsRoot, devPlugin, sandboxRead]));
    expect(settings.filesystem.denyRead).not.toContain("/srv");
    // Anything but a list of absolute paths is not a root.
    writeFileSync(file, JSON.stringify({ fsRoots: ["relative", 3, fsRoot] }));
    expect(readOwnerReadRoots(data).fsRoots).toEqual([fsRoot]);
  });

  it("are never reopened through a Python prefix that holds one, and reopen a binary inside one", () => {
    const { data, fsRoot } = roots();
    const python = "/srv/py/bin/python3";
    const block = {
      transport: "stdio",
      command: ["python", "-m", "x"],
      interpreter: { path: python, sha256: "0" },
    } as unknown as NonNullable<PluginManifest["mcp"]>;
    const policy = (denied?: readonly string[]) =>
      serverPolicy({
        pluginDirectory: join(data, "p"),
        home: join(data, "h"),
        dataDirectory: data,
        personHome: homedir(),
        block,
        nested: false,
        ...(denied === undefined ? {} : { ownerDenyRead: denied }),
      });
    expect(policy().allowRead).toContain("/srv/py");
    // An fs root inside the prefix: only the interpreter's own folder is opened.
    expect(policy(["/srv/py/work"]).allowRead).not.toContain("/srv/py");
    expect(policy(["/srv/py/work"]).allowRead).toContain(dirname(python));
    // FFmpeg installed inside an fs root is reopened, as one under home is.
    const ffmpeg = join(fsRoot, "tools", "bin", "ffmpeg");
    const denied = videoLibraryDenyRead(data, {
      platform: "linux",
      ownerDenyRead: ownerDenyRead({ dataDirectory: data, fsRoots: [fsRoot] }),
    });
    expect(
      libraryRoots(
        ffmpeg,
        denied,
        () => [],
        (path) => path,
      ),
    ).toEqual([join(fsRoot, "tools")]);
    expect(
      libraryRoots(
        ffmpeg,
        videoLibraryDenyRead(data, { platform: "linux", ownerDenyRead: [] }),
        () => [],
        (path) => path,
      ),
    ).toEqual([]);
  });

  it("reach a child launched through serve's composition", async () => {
    const { data, fsRoot } = roots();
    chmodSync(data, 0o700);
    const launches: ConfinedLaunch[] = [];
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: data,
        fsRoots: [fsRoot],
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
        providers: [],
        credentials: {},
        defaultConnectionId: "none",
        defaultModel: "none",
        logger: { level: "error", sink: () => undefined },
        scheduleSweepEnabled: false,
      },
      {
        requireModelTransport: false,
        confinementOverride: {
          wrap: (launch) => {
            launches.push(launch);
            throw new Error("recorded");
          },
        },
      },
    );
    try {
      const managed = join(data, "chats", "default", "t1");
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, "a.pdf"), "%PDF-1.4\n%%EOF\n");
      const folder = {
        primary: managed,
        primaryKind: "managed",
        managed,
        scratch: join(managed, ".tmp"),
        home: join(managed, ".home"),
        attachments: [],
        revision: 1,
      } as const;
      await runtime.tools
        .get("pdf.read")
        ?.handler({
          input: { source: { path: "a.pdf" } },
          context: { workspaceId: "default", principalId: "operator", runId: "t1", caller: "test", folder },
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
    } finally {
      await runtime.close();
    }
    expect(launches.length).toBeGreaterThan(0);
    expect(launches[0]?.policy.denyRead).toContain(fsRoot);
    expect(readOwnerReadRoots(data).fsRoots).toEqual([fsRoot]);
  });
});

describe("a folder given for chats", () => {
  it("is never /, a system folder or one holding it, Tavi's Node install, a relative path or a pattern", () => {
    for (const value of [
      "/",
      "/usr",
      "/usr/",
      "/opt",
      "/System",
      "/Library",
      "/lib64",
      "/bin",
      "/node/lib/x",
      "/node/bin",
      "/node",
      "relative/x",
      "/srv/w*rk",
    ]) {
      expect(readRootProblem("--fs-root", value, "/node"), value).toBeDefined();
    }
    for (const value of ["/srv/work", "/usr/local/src/project", "/node/share/sdk", "/Volumes/Code", "/Users/me"])
      expect(readRootProblem("--fs-root", value, "/node"), value).toBeUndefined();
    expect(() => parseArgs(["serve", "--fs-root", "/usr"])).toThrow(/system folder \/usr/);
    expect(() => parseArgs(["serve", "--sandbox-read", "/"])).toThrow(/system folder \//);
    expect(() => parseArgs(["serve", "--sandbox-read", "/srv/data[1]"])).toThrow(/as a pattern/);
    expect(parseArgs(["serve", "--fs-root", "/srv/work", "--sandbox-read", "/srv/reference"])).toMatchObject({
      serve: { fsRoots: ["/srv/work"], sandboxRead: ["/srv/reference"] },
    });
  });
});
