import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_MANIFEST_FILE, PluginManifestSchema } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { mcpAddManifest } from "../../src/features/mcp/add.js";
import { McpConnection } from "../../src/features/mcp/client.js";
import { stdioLaunch } from "../../src/features/mcp/launcher.js";
import { ownerConfinement } from "../../src/features/sandbox/host.js";
import {
  MCPB_PYTHON_BOOTSTRAP,
  bundleManifest,
  mcpbServer,
  unzipBundle,
  withoutSignature,
  type McpbManifest,
} from "../../src/features/mcp/mcpb.js";
import { capture } from "../support/attached-owner.js";
import { zip, type ZipEntry } from "../support/zip.js";

/** `.mcpb` bundles: read strictly, mapped to a server, and run in its sandbox. */

const RAW = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp", "raw-server.mjs");
const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

const manifest = (
  overrides: Partial<McpbManifest> & { readonly mcp_config?: McpbManifest["server"]["mcp_config"]; readonly type?: string } = {},
): McpbManifest => {
  const { mcp_config, type, ...rest } = overrides;
  return {
    manifest_version: "0.3",
    name: "raw-bundle",
    version: "1.2.0",
    display_name: "Raw bundle",
    description: "The raw server, bundled.",
    server: {
      type: type ?? "node",
      entry_point: "server/raw.mjs",
      mcp_config: mcp_config ?? { command: "node", args: ["${__dirname}/server/raw.mjs"] },
    },
    ...rest,
  };
};

const files = (extra: readonly ZipEntry[] = []) =>
  unzipBundle(
    zip([
      { name: "manifest.json", data: "{}" },
      { name: "server/", mode: 0o40755 },
      { name: "server/raw.mjs", data: "// raw", mode: 0o100644 },
      ...extra,
    ]),
  );

describe("reading a bundle", () => {
  it("unpacks stored and deflated entries with their execute bit, and skips macOS metadata", () => {
    const read = unzipBundle(
      zip([
        { name: "manifest.json", data: '{"name":"x"}', stored: true },
        { name: "server/bin/tool", data: Buffer.from([1, 2, 3]), mode: 0o100755 },
        { name: "server/index.js", data: "console.log(1)".repeat(50), mode: 0o100644 },
        { name: "__MACOSX/._index.js", data: "junk" },
      ]),
    );
    expect(read.map((file) => [file.path, file.executable])).toEqual([
      ["manifest.json", false],
      ["server/bin/tool", true],
      ["server/index.js", false],
    ]);
    expect(read[2]?.data.toString()).toBe("console.log(1)".repeat(50));
  });

  it("reads sizes from the central directory: data descriptors, a local extra field and an archive comment", () => {
    const read = unzipBundle(
      zip(
        [
          { name: "a.js", data: "deflated after a descriptor".repeat(20), descriptor: true },
          {
            name: "b.js",
            data: "stored, with a local extra field",
            stored: true,
            localExtra: Buffer.from([0x55, 0x54, 0x05, 0x00, 1, 0, 0, 0, 0]),
          },
        ],
        "made by a bundle tool",
      ),
    );
    expect(read.map((file) => file.data.toString())).toEqual([
      "deflated after a descriptor".repeat(20),
      "stored, with a local extra field",
    ]);
  });

  it("refuses a zip64 archive, a name that is both a file and a folder, and two names that differ only in Unicode form", () => {
    const zip64 = zip([{ name: "a", data: "x" }]);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    expect(() => unzipBundle(zip64)).toThrow(/is a zip64 archive/);
    expect(() =>
      unzipBundle(
        zip([
          { name: "a", data: "x" },
          { name: "a/b", data: "y" },
        ]),
      ),
    ).toThrow(/a is both a file and a folder/);
    expect(() =>
      unzipBundle(
        zip([
          { name: "caf\u00e9.js", data: "x" },
          { name: "cafe\u0301.js", data: "y" },
        ]),
      ),
    ).toThrow(/is in it twice/);
  });

  it("refuses a path out of the bundle, a symbolic link, a name twice in any case, encryption, a bad checksum, and what is over the limits", () => {
    expect(() => unzipBundle(zip([{ name: "../escape.js", data: "x" }]))).toThrow(/is not a path inside the bundle/);
    expect(() => unzipBundle(zip([{ name: "/etc/passwd", data: "x" }]))).toThrow(/is not a path inside the bundle/);
    expect(() => unzipBundle(zip([{ name: "a\\b.js", data: "x" }]))).toThrow(/is not a path inside the bundle/);
    expect(() => unzipBundle(zip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]))).toThrow(/is a symbolic link/);
    expect(() =>
      unzipBundle(
        zip([
          { name: "A.js", data: "x" },
          { name: "a.js", data: "y" },
        ]),
      ),
    ).toThrow(/is in it twice/);
    expect(() => unzipBundle(zip([{ name: "a.js", data: "x", flags: 1 }]))).toThrow(/is encrypted/);
    expect(() => unzipBundle(zip([{ name: "a.js", data: "x", crc: 1 }]))).toThrow(/does not match its checksum/);
    const limits = { maxFiles: 2, maxDirectories: 1, maxDepth: 2, maxBytes: 10 };
    expect(() =>
      unzipBundle(
        zip([
          { name: "a", data: "1" },
          { name: "b", data: "2" },
          { name: "c", data: "3" },
        ]),
        limits,
      ),
    ).toThrow(/more than 2 files/);
    expect(() => unzipBundle(zip([{ name: "a", data: "x".repeat(11) }]), limits)).toThrow(/unpacks to more than/);
    expect(() => unzipBundle(zip([{ name: "a/b/c", data: "x" }]), limits)).toThrow(/more than 2 folders deep/);
    expect(() =>
      unzipBundle(
        zip([
          { name: "a/x", data: "x" },
          { name: "b/y", data: "y" },
        ]),
        limits,
      ),
    ).toThrow(/more than 1 folders/);
    expect(() => unzipBundle(Buffer.from("not a zip"))).toThrow(/no end of central directory/);
  });

  it("sets a signature block aside, recording its scheme and size", () => {
    const plain = zip([{ name: "a", data: "x" }]);
    const block = Buffer.concat([Buffer.from("MCPB_SIG_V1"), Buffer.from([4, 0, 0, 0]), Buffer.from("cert"), Buffer.from("MCPB_SIG_END")]);
    const signed = withoutSignature(Buffer.concat([plain, block]));
    expect(signed.zip.equals(plain)).toBe(true);
    expect(signed.signature).toEqual({ scheme: "MCPB_SIG_V1", bytes: block.length });
    expect(withoutSignature(Buffer.concat([plain, Buffer.from("DXT_SIG_V1xxxxDXT_SIG_END")])).signature?.scheme).toBe("DXT_SIG_V1");
    expect(withoutSignature(plain).signature).toBeUndefined();
    expect(() => bundleManifest(unzipBundle(plain))).toThrow(/no manifest.json at its root/);
  });
});

describe("a bundle's server", () => {
  it("runs a Node bundle on Tavi's node from inside the bundle; a user_config field is a setting, a sensitive one a credential", () => {
    const server = mcpbServer(
      manifest({
        mcp_config: {
          command: "node",
          args: ["${__dirname}/server/raw.mjs", "--stdio"],
          env: { NOTES_DIR: "${user_config.notes}", API_KEY: "${user_config.api_key}", MODE: "read" },
        },
        user_config: {
          api_key: { type: "string", title: "API key", sensitive: true, required: true },
          notes: { type: "directory", title: "Notes", default: "${HOME}/Notes" },
          limit: { type: "number", default: 10 },
        },
      }),
      files(),
    );
    expect(server.command).toEqual(["node", "${package}/server/raw.mjs", "--stdio"]);
    expect(server.env).toEqual({ NOTES_DIR: { setting: "notes" }, API_KEY: { setting: "api_key" }, MODE: { value: "read" } });
    // A setting the environment is fed from is required, whatever the bundle says: Tavi sets no default for it.
    expect(server.config).toEqual({
      api_key: { type: "credential", required: true, description: "API key" },
      notes: { type: "string", required: true, description: 'Notes (the bundle\'s default: "${HOME}/Notes")' },
      limit: { type: "number", required: false, description: "limit (the bundle's default: 10)" },
    });
    expect(server.notes).toContain("setting notes is a directory: the server reaches it only once it is granted (--read or --write)");
  });

  it("applies this platform's override, and refuses a platform it does not list", () => {
    const overridden = mcpbServer(
      manifest({
        mcp_config: {
          command: "node",
          args: ["${__dirname}/server/raw.mjs"],
          platform_overrides: { linux: { args: ["${__dirname}/server/raw.mjs", "--linux"] } },
        },
      }),
      files(),
      "linux",
    );
    expect(overridden.command).toEqual(["node", "${package}/server/raw.mjs", "--linux"]);
    expect(() => mcpbServer(manifest({ compatibility: { platforms: ["win32"] } }), files(), "darwin")).toThrow(/runs on win32, not darwin/);
  });

  it("refuses what Tavi cannot run as reviewed: a setting in its arguments, a folder outside the bundle, uv, a missing entry, a secret literal", () => {
    expect(() =>
      mcpbServer(
        manifest({
          mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs", "--dir=${user_config.notes}"] },
          user_config: { notes: { type: "directory" } },
        }),
        files(),
      ),
    ).toThrow(/passes the setting notes inside a value/);
    expect(() =>
      mcpbServer(manifest({ mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs", "${HOME}/Documents"] } }), files()),
    ).toThrow(/names \$\{HOME\}, a folder outside the bundle/);
    expect(() => mcpbServer(manifest({ type: "uv", mcp_config: { command: "uv", args: ["run", "server.py"] } }), files())).toThrow(
      /installs its dependencies when it starts/,
    );
    expect(() => mcpbServer(manifest({ mcp_config: { command: "node", args: ["${__dirname}/server/missing.js"] } }), files())).toThrow(
      /which is not in the bundle/,
    );
    expect(() =>
      mcpbServer(manifest({ mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs"], env: { API_TOKEN: "abc" } } }), files()),
    ).toThrow(/looks secret but is a literal/);
    expect(() =>
      mcpbServer(
        manifest({ mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs"], env: { NODE_OPTIONS: "--require x" } } }),
        files(),
      ),
    ).toThrow(/NODE_OPTIONS would change what node loads/);
    expect(() =>
      mcpbServer(
        manifest({ mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs"], env: { X: "${user_config.nope}" } } }),
        files(),
      ),
    ).toThrow(/does not declare/);
    expect(() => mcpbServer(manifest({ mcp_config: { command: "node", args: [] } }), files())).toThrow(/names no entry point/);
  });

  it("runs a Python bundle through the bootstrap with its bundled folders first, and a binary only when it is executable", () => {
    const python = mcpbServer(
      manifest({
        type: "python",
        mcp_config: {
          command: "python",
          args: ["${__dirname}/server/main.py", "--x"],
          env: { PYTHONPATH: "${__dirname}/server/lib:${__dirname}/server" },
        },
      }),
      files([{ name: "server/main.py", data: "print(1)" }]),
    );
    expect(python.command).toEqual([
      "python",
      "-I",
      "-B",
      "-c",
      MCPB_PYTHON_BOOTSTRAP,
      "2",
      "${package}/server/lib",
      "${package}/server",
      "${package}/server/main.py",
      "--x",
    ]);
    expect(python.env).toEqual({});
    expect(
      mcpbServer(manifest({ type: "python", mcp_config: { command: "python3", args: ["-m", "notes.server"] } }), files()).command.slice(5),
    ).toEqual(["0", "-m:notes.server"]);
    expect(
      mcpbServer(
        manifest({ type: "binary", mcp_config: { command: "${__dirname}/server/bin/tool", args: [] } }),
        files([{ name: "server/bin/tool", data: "x", mode: 0o100755 }]),
      ).command,
    ).toEqual(["${package}/server/bin/tool"]);
    expect(() =>
      mcpbServer(
        manifest({ type: "binary", mcp_config: { command: "${__dirname}/server/bin/tool" } }),
        files([{ name: "server/bin/tool", data: "x", mode: 0o100644 }]),
      ),
    ).toThrow(/is not marked executable/);
  });

  it("becomes an mcp-mcpb manifest named by the operator: the bundle's version and description (cleaned), its file's integrity, the operator's --env over its own", () => {
    const bundle = manifest({
      mcp_config: { command: "node", args: ["${__dirname}/server/raw.mjs"], env: { MODE: "read" } },
      license: "MIT",
      user_config: { api_key: { type: "string", sensitive: true } },
    });
    const written = mcpAddManifest(
      { slug: "rawb", form: { kind: "mcpb", path: "/x.mcpb", args: ["--verbose"] }, env: ["MODE=write"] },
      undefined,
      undefined,
      undefined,
      { manifest: bundle, server: mcpbServer(bundle, files()), integrity: `sha512-${"A".repeat(86)}==` },
    );
    expect(PluginManifestSchema.parse(written)).toMatchObject({
      id: "mcp.rawb",
      version: "1.2.0",
      name: "rawb",
      description: "The raw server, bundled.",
      provenance: { format: "mcp-mcpb", packages: [{ name: "raw-bundle", version: "1.2.0", license: "MIT" }] },
      config: { api_key: { type: "credential", required: false } },
      mcp: { command: ["node", "${package}/server/raw.mjs", "--verbose"], env: { MODE: { value: "write" } } },
    });
  });

  it("cleans the publisher's words: a setting's title and description, the description and license", () => {
    const bundle = manifest({
      description: "Notes\u001b[31m.\u202e",
      license: "MIT\u0007",
      user_config: { key: { type: "string", title: "Key\u202e", description: "Your\u001b[2J key", sensitive: true } },
    });
    const server = mcpbServer(bundle, files());
    expect(server.config["key"]?.description).toBe("Key: Your key");
    const written = mcpAddManifest({ slug: "notes", form: { kind: "mcpb", path: "/x.mcpb", args: [] } }, undefined, undefined, undefined, {
      manifest: bundle,
      server,
      integrity: `sha512-${"A".repeat(86)}==`,
    });
    expect(written).toMatchObject({ name: "notes", description: "Notes.", provenance: { packages: [{ license: "MIT" }] } });
  });

  it("parses --mcpb with the server's extra arguments", () => {
    expect(parseArgs(["mcp", "add", "notes", "--mcpb", "/tmp/notes.mcpb", "--", "--stdio"]).mcp).toMatchObject({
      action: "add",
      slug: "notes",
      form: { kind: "mcpb", path: "/tmp/notes.mcpb", args: ["--stdio"] },
    });
  });
});

/** A bundle of the dependency-free raw server, signed with a block Tavi shows and never checks. */
function rawBundle(): string {
  const directory = directories.create("tavi-mcpb-");
  const body = zip([
    {
      name: "manifest.json",
      data: JSON.stringify({ ...manifest(), user_config: { api_key: { type: "string", title: "API key", sensitive: true } } }),
    },
    { name: "server/raw.mjs", data: readFileSync(RAW), mode: 0o100644 },
  ]);
  const path = join(directory, "raw.mcpb");
  writeFileSync(
    path,
    Buffer.concat([body, Buffer.from("MCPB_SIG_V1"), Buffer.from([4, 0, 0, 0]), Buffer.from("cert"), Buffer.from("MCPB_SIG_END")]),
  );
  return path;
}

describe.skipIf(process.platform !== "darwin")("a bundle in its sandbox (macOS)", () => {
  it("installs, is probed, approved and runs sandboxed from its own files", async () => {
    const data = directories.create("tavi-mcpb-");
    const home = directories.create("tavi-mcpb-home-");
    writeFileSync(join(home, "secret.txt"), "not for servers\n");
    const at = ["--data-dir", data];
    const added = await tavi(["mcp", "add", "rawb", "--mcpb", rawBundle(), ...at]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    expect(added.stdout).toContain("added mcp.rawb@1.2.0 (proposed)");
    expect(added.stdout).toContain("2 files from the bundle raw-bundle 1.2.0 (sha512-");
    expect(added.stdout).toContain(
      "signed (MCPB_SIG_V1, 31 bytes): shown only — the signature is not checked, and it is not a reason to trust the bundle",
    );
    expect(added.stdout).toContain("credentials to set: api_key");
    expect(added.stdout).toContain("mcp.rawb@1.2.0 (proposed), sandbox: srt");
    expect(added.stdout).toMatch(/echo → mcp\.rawb\.echo \[pending\]/);
    expect((await tavi(["mcp", "approve", "mcp.rawb", "1.2.0", "--effect", "connect=external", "--disable", "write", ...at])).code).toBe(
      EXIT.ok,
    );
    expect((await tavi(["mcp", "verify", "mcp.rawb", "--full", ...at])).stdout).toMatch(/files as approved \(\d+ re-hashed\)/);
    // The approved snapshot holds the bundle's files under server/, and runs in srt from there.
    const plugin = join(data, "plugins", "mcp.rawb", "1.2.0");
    expect(statSync(join(plugin, "server", "server", "raw.mjs")).isFile()).toBe(true);
    const installed = PluginManifestSchema.parse(JSON.parse(readFileSync(join(plugin, PLUGIN_MANIFEST_FILE), "utf8")));
    const spawn = stdioLaunch(
      { pluginId: "mcp.rawb", manifest: installed, pluginDirectory: plugin, sandboxState: "srt", env: {} },
      { dataDirectory: data, home, confinement: ownerConfinement() },
    );
    const connection = new McpConnection({ endpoint: { transport: "stdio", spawn } });
    try {
      expect((await connection.callTool("echo", { text: "from the bundle" })).content).toBe("from the bundle");
      expect((await connection.callTool("read", { path: join(home, "secret.txt") })).content).toMatch(/^denied/);
      expect((await connection.callTool("connect", { host: "1.1.1.1", port: 443 })).content).toMatch(/^denied/);
    } finally {
      await connection.close();
    }
  }, 120_000);
});
