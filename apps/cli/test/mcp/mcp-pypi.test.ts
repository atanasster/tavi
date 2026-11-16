import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_ABI, McpBlockSchema, mcpFilesystemProblems, mcpInterpreterPrefix } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { EXIT, main } from "../../src/main.js";
import { mcpAddManifest, writeMcpPluginDirectory } from "../../src/features/mcp/add.js";
import { resolveArgv, serverPolicy, stdioLaunch } from "../../src/features/mcp/launcher.js";
import { ownerConfinement } from "../../src/features/sandbox/host.js";
import {
  PYTHON_BOOTSTRAP,
  consoleScriptOf,
  fetchPypiServer,
  findUv,
  parsePypiSpec,
  type PypiFetchOptions,
} from "../../src/features/mcp/pypi.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** Python servers (`--pypi`). */

const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

/**
 * The pretend uv and its interpreter: fixed files (see fixtures/fake-uv/uv for
 * why never a fresh executable per test). The uv answers as `script` says per
 * command, from `uv.sh` in a directory of the test's own, named by `FAKE_UV`.
 */
const FAKE_UV = fileURLToPath(new URL("../fixtures/fake-uv/", import.meta.url));
const fakeUvOptions = (answers: string): PypiFetchOptions => ({ uv: join(FAKE_UV, "uv"), uvEnv: { FAKE_UV: answers } });
function fakeUv(script: { readonly compile?: string; readonly install?: string; readonly managedDir?: string }): {
  readonly options: PypiFetchOptions;
  readonly python: string;
  readonly answers: string;
} {
  const directory = directories.create("tavi-fake-uv-");
  const python = join(FAKE_UV, "python", "bin", "python3.12");
  const answers = join(directory, "uv.sh");
  writeFileSync(
    answers,
    `case "$1 $2" in
  "python find") echo "${python}" ;;
  "python dir") echo "${script.managedDir ?? join(FAKE_UV, "python")}" ;;
  "pip compile") ${script.compile ?? `printf 'mcp-server-time==1.0.0 \\\\\\n    --hash=sha256:${"a".repeat(64)}\\n' > requirements.txt`} ;;
  "pip install") ${script.install ?? "mkdir -p site/mcp_server_time-1.0.0.dist-info && printf '[console_scripts]\\nmcp-server-time = mcp_server_time:main\\n' > site/mcp_server_time-1.0.0.dist-info/entry_points.txt && printf 'License-Expression: MIT\\n' > site/mcp_server_time-1.0.0.dist-info/METADATA"} ;;
esac
`,
  );
  return { options: fakeUvOptions(directory), python, answers };
}

describe("parsing and the manifest", () => {
  it("takes an exact version only", () => {
    expect(parsePypiSpec("mcp-server-time==2026.10.10")).toEqual({ name: "mcp-server-time", version: "2026.10.10" });
    expect(() => parsePypiSpec("mcp-server-time")).toThrow(/takes <package>==<exact version>/);
    expect(() => parsePypiSpec("mcp-server-time>=1")).toThrow(/takes <package>==<exact version>/);
    expect(() => parsePypiSpec("mcp-server-time==1.*")).toThrow(/needs an exact version/);
    expect(parseArgs(["mcp", "add", "time", "--pypi", "mcp-server-time==1.0.0", "--", "--local-timezone", "UTC"])).toMatchObject({
      mcp: { form: { kind: "pypi", spec: "mcp-server-time==1.0.0", args: ["--local-timezone", "UTC"] } },
    });
  });

  it("chooses the console script named like the package, or the only one", () => {
    expect(consoleScriptOf("mcp-server-time", "[console_scripts]\nmcp-server-time = mcp_server_time:main\n")).toBe("mcp_server_time:main");
    expect(consoleScriptOf("x", "[console_scripts]\nrun = pkg.cli:app.run\n")).toBe("pkg.cli:app.run");
    expect(() => consoleScriptOf("x", "[console_scripts]\na = m:a\nb = m:b\n")).toThrow(/several programs \(a, b\)/);
    expect(() => consoleScriptOf("x", "")).toThrow(/no console script/);
  });

  it("writes python, isolated, running the script from the installed tree, with the interpreter pinned", () => {
    const interpreter = { path: "/opt/uv/python/cpython-3.12.15/bin/python3.12", sha256: "b".repeat(64), version: "3.12.15" };
    const manifest = mcpAddManifest({ slug: "time", form: { kind: "pypi", spec: "mcp-server-time==1.0.0", args: ["--x"] } }, undefined, {
      name: "mcp-server-time",
      version: "1.0.0",
      integrity: `sha256:${"a".repeat(64)}`,
      license: "MIT",
      entry: "mcp_server_time:main",
      interpreter,
      native: [],
      files: 3,
    });
    expect(manifest).toMatchObject({
      provenance: { format: "mcp-pypi" },
      mcp: {
        package: { registry: "pypi", name: "mcp-server-time", version: "1.0.0" },
        interpreter,
        command: ["python", "-I", "-B", "-c", PYTHON_BOOTSTRAP, "${package}/site", "mcp_server_time:main", "--x"],
      },
    });
    // At launch `python` is that interpreter, and the sandbox reads its install.
    expect(resolveArgv(manifest, "/plugins/mcp.time/1.0.0")[0]).toBe(interpreter.path);
    expect(resolveArgv(manifest, "/plugins/mcp.time/1.0.0")[5]).toBe("/plugins/mcp.time/1.0.0/package/site");
    const policy = serverPolicy({
      pluginDirectory: "/plugins/mcp.time/1.0.0",
      home: "/data/mcp/mcp.time/home",
      dataDirectory: "/data",
      personHome: "/Users/me",
      block: manifest.mcp!,
      nested: false,
    });
    expect(policy.allowRead).toContain(mcpInterpreterPrefix(interpreter.path));
    expect(mcpInterpreterPrefix(interpreter.path)).toBe("/opt/uv/python/cpython-3.12.15");
  });

  it("refuses python without its pinned interpreter, an interpreter on another command, and one whose install is too wide a grant", () => {
    const base = { abi: MCP_ABI, transport: "stdio" as const };
    const interpreter = { path: "/opt/uv/python/cpython-3.12.15/bin/python3.12", sha256: "b".repeat(64), version: "3.12.15" };
    expect(McpBlockSchema.safeParse({ ...base, command: ["python", "x.py"] }).error?.issues.map((issue) => issue.message)).toContain(
      "a python command needs its pinned interpreter (add it with --pypi, or --dir with uv)",
    );
    expect(
      McpBlockSchema.safeParse({ ...base, command: ["node", "x.js"], interpreter }).error?.issues.map((issue) => issue.message),
    ).toContain("interpreter applies to a python command only");
    expect(
      McpBlockSchema.safeParse({
        ...base,
        command: ["python", "x.py"],
        interpreter: { ...interpreter, path: "python3" },
      }).error?.issues.map((issue) => issue.message),
    ).toContain("interpreter.path is an absolute path");
    const problems = (path: string) =>
      mcpFilesystemProblems(McpBlockSchema.parse({ ...base, command: ["python", "x.py"], interpreter: { ...interpreter, path } }), {
        home: "/Users/me",
        dataDirectory: "/Users/me/.tavi",
      });
    expect(problems(interpreter.path)).toEqual([]);
    expect(problems("/Users/me/.local/share/uv/python/cpython-3.12.15/bin/python3.12")).toEqual([]);
    expect(problems("/bin/sh")[0]).toContain("too wide a grant");
    expect(problems("/Users/bin/python")[0]).toContain("too wide a grant");
    expect(problems("/Users/me/.ssh/bin/python")[0]).toContain("another tool's credentials");
  });
});

describe("the launcher", () => {
  const manifestWith = (path: string, sha256: string) =>
    mcpAddManifest({ slug: "time", form: { kind: "pypi", spec: "x==1.0.0", args: [] } }, undefined, {
      name: "x",
      version: "1.0.0",
      integrity: `sha256:${"a".repeat(64)}`,
      license: "MIT",
      entry: "x:main",
      interpreter: { path, sha256, version: "3.12.15" },
      native: [],
      files: 1,
    });
  it("refuses an interpreter that is gone, or changed since it was pinned, and starts the one pinned", () => {
    const { python } = fakeUv({});
    const data = directories.create("tavi-mcp-pypi-");
    const launch = (path: string, sha256: string) =>
      stdioLaunch(
        { pluginId: "mcp.time", manifest: manifestWith(path, sha256), pluginDirectory: data, sandboxState: "none", env: {} },
        { dataDirectory: data, confinement: ownerConfinement() },
      );
    expect(() => launch("/nonexistent/bin/python3.12", "c".repeat(64))).toThrow(
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("is not there any more") }),
    );
    expect(() => launch(python, "c".repeat(64))).toThrow(
      expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("changed since it was approved") }),
    );
    const sha256 = createHash("sha256").update(readFileSync(python)).digest("hex");
    expect(launch(python, sha256).command).toBe(python);
  });
});

describe("the fetch, against a pretend uv", () => {
  it("pins the managed interpreter for a local server run with python, asked from an empty directory", async () => {
    const { options, python } = fakeUv({});
    const server = directories.create("tavi-py-server-");
    writeFileSync(join(server, "server.py"), "print('hi')\n");
    const written = await writeMcpPluginDirectory(
      { slug: "local", form: { kind: "dir", path: server, argv: ["python", "server.py"] } },
      { dataDirectory: directories.create("tavi-mcp-pypi-"), pypi: options },
    );
    expect(written.manifest.mcp).toMatchObject({
      command: ["python", "${package}/server.py"],
      interpreter: { path: realpathSync(python), version: "3.12.15" },
    });
  });

  it("refuses an interpreter uv does not manage", async () => {
    const { options } = fakeUv({ managedDir: "/nonexistent-uv-python" });
    await expect(fetchPypiServer({ name: "x", version: "1.0.0" }, directories.create("tavi-mcp-pypi-"), options)).rejects.toThrow();
    const elsewhere = directories.create("tavi-uv-managed-");
    const { options: other } = fakeUv({ managedDir: elsewhere });
    await expect(fetchPypiServer({ name: "x", version: "1.0.0" }, directories.create("tavi-mcp-pypi-"), other)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("which it does not manage"),
    });
  });

  it("says another Python is the fix when wheels exist only for other interpreters", async () => {
    const { options } = fakeUv({
      compile: "echo 'Because pydantic-core==9.9.9 has no wheels with a matching Python ABI tag (e.g., cp312)' >&2; exit 1",
    });
    await expect(fetchPypiServer({ name: "x", version: "1.0.0" }, directories.create("tavi-mcp-pypi-"), options)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("has no wheel for Python 3.12.15 on this platform"),
    });
  });

  it("pins the interpreter by hash, the wheel by the hash uv pinned, and finds the program", async () => {
    const { options, python } = fakeUv({});
    const directory = directories.create("tavi-mcp-pypi-");
    const fetched = await fetchPypiServer({ name: "mcp-server-time", version: "1.0.0" }, directory, options);
    expect(fetched).toMatchObject({
      name: "mcp-server-time",
      integrity: `sha256:${"a".repeat(64)}`,
      entry: "mcp_server_time:main",
      license: "MIT",
      files: 1,
      native: [],
    });
    expect(fetched.interpreter).toMatchObject({ path: realpathSync(python), version: "3.12.15" });
    expect(fetched.interpreter.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(directory, "requirements.in"), "utf8")).toBe("mcp-server-time==1.0.0\n");
  });

  it("refuses an sdist-only package, naming why", async () => {
    const { options } = fakeUv({
      compile:
        "echo '  × No solution found when resolving dependencies: Because docopt==0.6.2 has no usable wheels and building from source is disabled' >&2; exit 1",
    });
    await expect(
      fetchPypiServer({ name: "docopt", version: "0.6.2" }, directories.create("tavi-mcp-pypi-"), options),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("publishes only a source distribution, which Tavi never builds"),
    });
  });

  it("fails when a downloaded file's hash is not the one pinned", async () => {
    const { options } = fakeUv({ install: "echo 'error: Hash mismatch for `mcp-server-time==1.0.0`' >&2; exit 1" });
    await expect(
      fetchPypiServer({ name: "mcp-server-time", version: "1.0.0" }, directories.create("tavi-mcp-pypi-"), options),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("hash is not the one pinned") });
  });

  it("asks for a uv-managed interpreter, and for uv itself", async () => {
    const { options, answers } = fakeUv({});
    writeFileSync(answers, "exit 2\n");
    await expect(fetchPypiServer({ name: "x", version: "1.0.0" }, directories.create("tavi-mcp-pypi-"), options)).rejects.toThrow(
      /uv found no Python interpreter it manages \(.*\): run `uv python install 3.12`/,
    );
    expect(findUv("/nonexistent")).toBeUndefined();
  });
});

/** The real thing, where uv is installed (with a managed interpreter): the public index, a real server, the real sandbox. */
const uvPresent = findUv() !== undefined;
describe.skipIf(!uvPresent)("with uv (live)", () => {
  it("mcp-server-time installs from wheels, probes and runs sandboxed with no network; an sdist-only package and a changed wheel hash are refused", async () => {
    const data = directories.create("tavi-mcp-pypi-");
    const at = ["--data-dir", data];
    const added = await tavi(["mcp", "add", "time", "--pypi", "mcp-server-time==2026.10.10", ...at, "--", "--local-timezone", "UTC"]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    expect(added.stdout).toContain("packages from PyPI, wheels only, every one pinned by its hash");
    // The probe ran it in its sandbox (srt, no network granted) and listed its tools.
    expect(added.stdout).toMatch(/sandbox: srt/);
    expect(added.stdout).toContain("get_current_time");
    expect(added.stdout).toContain("network: none");
    const approved = await tavi(["mcp", "approve", "mcp.time", "1.0.0", ...at]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.time", ...at])).code).toBe(EXIT.ok);
    // It runs in its sandbox, with no network granted: a call answers.
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    try {
      const answer = await runtime.mcp.supervisor.call("mcp.time", "get_current_time", { timezone: "Europe/Sofia" }, { timeoutMs: 30_000 });
      expect(JSON.stringify(answer)).toContain("Europe/Sofia");
      expect(runtime.mcp.supervisor.status("mcp.time")).toMatchObject({ state: "running" });
    } finally {
      await runtime.close();
    }

    const sdist = await tavi(["mcp", "add", "docs", "--pypi", "docopt==0.6.2", "--no-probe", ...at]);
    expect(sdist.code).not.toBe(EXIT.ok);
    expect(sdist.stderr).toContain("publishes only a source distribution, which Tavi never builds");

    // A changed hash: uv refuses to install a wheel whose bytes are not the ones pinned.
    const real = findUv() as string;
    const wrapper = directories.create("tavi-uv-wrap-");
    writeFileSync(
      join(wrapper, "uv.sh"),
      `if [ "$1 $2" = "pip install" ]; then sed -i.bak -E 's/sha256:[0-9a-f]{64}/sha256:${"0".repeat(64)}/' requirements.txt; fi
exec "${real}" "$@"
`,
    );
    await expect(
      fetchPypiServer({ name: "mcp-server-time", version: "2026.10.10" }, directories.create("tavi-mcp-pypi-"), fakeUvOptions(wrapper)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }, 300_000);
});
