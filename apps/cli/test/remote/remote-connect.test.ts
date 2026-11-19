import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { capture, delay, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { connectLiveOwner } from "../../src/cli/owner-connection.js";
import { withStore } from "../../src/cli/store.js";
import { hostPathOf } from "../../src/features/folders/owner.js";
import {
  type RemoteConnection,
  type RemoteConnector,
  type RemoteResult,
  defaultMirrorDirectory,
  mirrorPaths,
  mirrorRefusal,
  parsePublished,
  publishedScript,
  remoteConnect,
  remoteDataDirectoryOf,
  shellQuote,
  untarFrom,
} from "../../src/features/remote/connect.js";
import { clientCwdFor, remoteFoldersOf, remotePathOf } from "../../src/features/remote/folders.js";
import { EXIT, main } from "../../src/main.js";
import { fixtureOwners } from "../support/serve-fixture.js";

/**
 * `tavi remote connect`: clients on this computer, attached to an owner on
 * another one through a mirror directory.
 *
 * The "other computer" here is this one: the connector runs each remote
 * command with `/bin/sh` and forwards the socket by a link, which is what
 * SSH's forward amounts to for a client. What is under test is everything
 * around it: the mirror's files, following the owner's restarts, the refusal
 * to open a mirror offline, and that clients send no path of this computer.
 */

const directories = temporaryDirectories({ prefix: "tavi-remote-" });
const owners = fixtureOwners();
const startOwner = owners.start;

afterEach(async () => {
  await owners.stopAll();
  directories.cleanup();
});

function sh(script: string): Promise<RemoteResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A connector to this computer: each script in `/bin/sh`, the forward a link. `drop` ends the connection. */
function localConnector(): { readonly connector: RemoteConnector; readonly drop: () => void; readonly scripts: string[] } {
  let drop = (): void => undefined;
  const scripts: string[] = [];
  const connector: RemoteConnector = async () => {
    let end = (_why: string): void => undefined;
    const ended = new Promise<string>((resolve) => {
      end = resolve;
    });
    drop = () => end("dropped");
    const connection: RemoteConnection = {
      run: (script) => {
        scripts.push(script);
        return sh(script);
      },
      forward: async (local, remote) => {
        symlinkSync(remote, local);
      },
      copy: (script, directory) => {
        scripts.push(script);
        return untarFrom("/bin/sh", ["-c", script], directory);
      },
      ended,
      close: async () => end("closed"),
    };
    return connection;
  };
  return { connector, drop: () => drop(), scripts };
}

/** `tavi remote connect` to `target` running until `stop`, polling and reconnecting fast; `running` is its exit code. */
function connecting(
  target: string,
  remote: string,
  mirror: string,
  connector: RemoteConnector,
  out: ReturnType<typeof capture>,
): { readonly stop: () => void; readonly running: Promise<number> } {
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const running = remoteConnect(
    { action: "connect", target, mirrorDirectory: mirror, remoteDataDirectory: remote, sshOptions: [] },
    out.io,
    EXIT,
    { connector, stopped, pollMs: 25, reconnectMs: 25 },
  );
  return { stop: () => stop(), running };
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

describe("tavi remote connect", () => {
  it("attaches clients to the remote owner, follows its restart, and withdraws it on stop", async () => {
    const remote = directories.create();
    const mirror = join(directories.create(), "m");
    await startOwner(remote);

    const out = capture();
    const { connector } = localConnector();
    const { stop, running } = connecting("brook@mini.lan", remote, mirror, connector, out);
    const paths = mirrorPaths(mirror);
    await until(() => existsSync(paths.discovery), "the mirror's discovery");
    expect(JSON.parse(readFileSync(paths.marker, "utf8"))).toMatchObject({
      version: 1,
      target: "brook@mini.lan",
      remoteDataDirectory: remote,
    });
    expect(JSON.parse(readFileSync(paths.discovery, "utf8")).endpoint).toBe(paths.socket);

    const client = await connectLiveOwner(mirror, ["tasks"]);
    expect(client?.features).toContain("tasks");
    client?.close();
    expect(await main(["tasks", "--data-dir", mirror], { io: capture().io })).toBe(EXIT.ok);

    // The owner restarts there: a new session and token, which the mirror follows.
    const first = JSON.parse(readFileSync(paths.discovery, "utf8")).sessionId as string;
    await owners.stopLast("restart");
    await until(() => !existsSync(paths.discovery), "the stopped owner withdrawn");
    await expect(connectLiveOwner(mirror, ["tasks"])).rejects.toThrow(/Cannot reach the owner on brook@mini\.lan/);
    await startOwner(remote);
    await until(
      () => existsSync(paths.discovery) && JSON.parse(readFileSync(paths.discovery, "utf8")).sessionId !== first,
      "the new session",
    );
    const again = await connectLiveOwner(mirror, ["tasks"]);
    again?.close();
    expect(out.stdout()).toMatch(/Connected to the owner on brook@mini\.lan/);
    expect(out.stdout()).toMatch(/No owner is running/);
    expect(out.stdout()).toMatch(/is running again/);
    expect(out.stdout().match(/Connected to the owner/g)).toHaveLength(1);

    stop();
    expect(await running).toBe(EXIT.ok);
    expect(existsSync(paths.discovery)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
    // The private directory made there for the link is removed.
    expect(out.stderr()).toBe("");
  });

  it("copies the remote owner's installed plugin versions for the canvas, and follows installs and removals", async () => {
    const remote = directories.create();
    const mirror = join(directories.create(), "m");
    const install = (folder: string, text: string): void => {
      mkdirSync(join(remote, "plugins", folder, "ui"), { recursive: true });
      writeFileSync(join(remote, "plugins", folder, "ui", "index.html"), text);
      writeFileSync(join(remote, "plugins", folder, "plugin.json"), "{}");
    };
    install("acme.panel/1.0.0", "<p>one</p>");
    mkdirSync(join(remote, "plugins", ".dev", "acme.local"), { recursive: true });
    // A plugin's home is its own private state: never copied.
    mkdirSync(join(remote, "plugins", "acme.panel", "home"), { recursive: true });
    writeFileSync(join(remote, "plugins", "acme.panel", "home", "secret.txt"), "private");
    await startOwner(remote);
    const out = capture();
    const { stop, running } = connecting("mini", remote, mirror, localConnector().connector, out);
    const paths = mirrorPaths(mirror);
    const copied = (folder: string): string => join(paths.plugins, folder, "ui", "index.html");
    await until(() => existsSync(copied("acme.panel/1.0.0")), "the installed plugin copied");
    expect(readFileSync(copied("acme.panel/1.0.0"), "utf8")).toBe("<p>one</p>");
    expect(existsSync(join(paths.plugins, ".dev"))).toBe(false);
    expect(existsSync(join(paths.plugins, "acme.panel", "home"))).toBe(false);

    // A new version installed there arrives; the one removed there goes.
    install("acme.panel/1.1.0", "<p>two</p>");
    rmSync(join(remote, "plugins", "acme.panel", "1.0.0"), { recursive: true });
    await until(
      () => existsSync(copied("acme.panel/1.1.0")) && !existsSync(join(paths.plugins, "acme.panel", "1.0.0")),
      "the plugin update",
    );
    expect(readFileSync(copied("acme.panel/1.1.0"), "utf8")).toBe("<p>two</p>");

    stop();
    expect(await running).toBe(EXIT.ok);
    expect(out.stderr()).toBe("");
    // The mirror stays a mirror with its plugin copies in it.
    expect(mirrorRefusal(mirror, "mini")).toBeUndefined();
  });

  it("signs in again after the connection drops", async () => {
    const remote = directories.create();
    const mirror = join(directories.create(), "m");
    await startOwner(remote);
    const out = capture();
    const local = localConnector();
    const { stop, running } = connecting("mini", remote, mirror, local.connector, out);
    const paths = mirrorPaths(mirror);
    await until(() => existsSync(paths.discovery), "the first connection");
    local.drop();
    await until(() => out.stderr().includes("ended; signing in again"), "the reconnect notice");
    await until(() => existsSync(paths.discovery), "the second connection");
    (await connectLiveOwner(mirror, ["tasks"]))?.close();
    stop();
    expect(await running).toBe(EXIT.ok);
  });

  it("is never opened as a data directory of its own", async () => {
    const mirror = directories.create();
    writeFileSync(
      join(mirror, "remote.json"),
      JSON.stringify({ version: 1, target: "mini", remoteDataDirectory: "/srv/tavi", remoteHome: "/home/brook" }),
    );
    // No owner published: a client is refused, never sent to the database.
    await expect(connectLiveOwner(mirror, ["tasks"])).rejects.toThrow(/Cannot reach the owner on mini/);
    const tasks = capture();
    expect(await main(["tasks", "--data-dir", mirror], { io: tasks.io })).toBe(EXIT.unavailable);
    expect(tasks.stderr()).toMatch(/tavi remote connect mini/);
    // And no offline command (nor `tavi serve`) can own it.
    await expect(withStore(mirror, async () => undefined)).rejects.toThrow(/mirrors the owner on mini \(\/srv\/tavi\)/);
    expect(existsSync(join(mirror, "tavi.sqlite"))).toBe(false);
  });

  it("refuses a mirror directory that is another target's, holds data, or is too long for a socket", () => {
    const dataDirectory = directories.create();
    writeFileSync(join(dataDirectory, "tavi.sqlite"), "");
    expect(mirrorRefusal(dataDirectory, "mini")).toMatch(/not empty and not a remote mirror/);
    const other = directories.create();
    writeFileSync(join(other, "remote.json"), JSON.stringify({ version: 1, target: "nas", remoteDataDirectory: "/d", remoteHome: "/h" }));
    expect(mirrorRefusal(other, "mini")).toMatch(/mirrors nas, not mini/);
    expect(mirrorRefusal(other, "nas")).toBeUndefined();
    expect(mirrorRefusal("/tmp/has space/m", "mini")).toMatch(/space or a colon/);
    expect(mirrorRefusal(`/tmp/${"x".repeat(80)}`, "mini")).toMatch(/too long/);
    expect(mirrorRefusal(join(directories.create(), "f"), "mini")).toBeUndefined();
  });

  it("refuses a target that is not a host, and a second connect on the same mirror", async () => {
    const usage = capture();
    expect(await main(["remote", "connect", "-oProxyCommand=x"], { io: usage.io })).toBe(EXIT.usage);
    expect(await main(["remote", "connect", "a;b"], { io: usage.io })).toBe(EXIT.usage);
    expect(await main(["remote", "connect", "mini", "--ssh-option", "nonsense"], { io: usage.io })).toBe(EXIT.usage);

    const mirror = join(directories.create(), "m");
    const paths = mirrorPaths(mirror);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(paths.pid, String(process.ppid));
    const out = capture();
    const code = await remoteConnect({ action: "connect", target: "mini", mirrorDirectory: mirror, sshOptions: [] }, out.io, EXIT, {
      connector: localConnector().connector,
      stopped: new Promise(() => undefined),
    });
    expect(code).toBe(EXIT.unavailable);
    expect(out.stderr()).toMatch(/already keeps/);
    rmSync(paths.pid);
  });
});

describe("what the remote side is read as", () => {
  it("finds the owner's data directory as Tavi's default there", () => {
    expect(remoteDataDirectoryOf({ home: "/Users/brook", system: "Darwin", xdgDataHome: "" })).toBe(
      "/Users/brook/Library/Application Support/tavi",
    );
    expect(remoteDataDirectoryOf({ home: "/home/b", system: "Linux", xdgDataHome: "" })).toBe("/home/b/.local/share/tavi");
    expect(remoteDataDirectoryOf({ home: "/home/b", system: "Linux", xdgDataHome: "/data" })).toBe("/data/tavi");
    expect(remoteDataDirectoryOf({ home: "/home/b", system: "Linux", xdgDataHome: "" }, "~/t")).toBe("/home/b/t");
    expect(() => remoteDataDirectoryOf({ home: "/home/b", system: "Linux", xdgDataHome: "" }, "t")).toThrow(/absolute/);
  });

  it("reads the owner's publication, and nothing that is not one", () => {
    const discovery = { protocolVersion: 7, sessionId: "serve-1", endpoint: "/x/ipc.sock", pid: 1, startedAt: "now" };
    expect(parsePublished(`${JSON.stringify(discovery)}\n--tavi-remote-token--\nabc=\n`)).toEqual({
      discovery,
      token: "abc=",
      plugins: [],
    });
    expect(
      parsePublished(
        `${JSON.stringify(discovery)}\n--tavi-remote-token--\nabc=\n--tavi-remote-plugins--\nb.p/2.0.0\na.p/1.0.0\na.p/home\n../x\n.dev/a\n*/*/\n`,
      ),
    ).toEqual({ discovery, token: "abc=", plugins: ["a.p/1.0.0", "b.p/2.0.0"] });
    expect(parsePublished("{}\n--tavi-remote-token--\nabc")).toBeUndefined();
    expect(parsePublished(JSON.stringify(discovery))).toBeUndefined();
    expect(publishedScript("/Users/b/Library/Application Support/tavi")).toContain("'/Users/b/Library/Application Support/tavi/runtime'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("names the default mirror after the host", () => {
    expect(defaultMirrorDirectory("brook@mini.lan", "/Users/me")).toBe("/Users/me/.tavi-remote/mini.lan");
    expect(defaultMirrorDirectory("[fe80::1]", "/Users/me")).toBe("/Users/me/.tavi-remote/_fe80__1_");
  });
});

describe("folders sent to a remote owner", () => {
  it("are the remote computer's: ~ its home, a relative path refused, and no terminal directory", () => {
    const mirror = directories.create();
    writeFileSync(
      join(mirror, "remote.json"),
      JSON.stringify({ version: 1, target: "mini", remoteDataDirectory: "/d", remoteHome: "/Users/brook" }),
    );
    const remote = remoteFoldersOf(mirror);
    expect(remote).toEqual({ target: "mini", home: "/Users/brook" });
    expect(remotePathOf("~", { target: "mini", home: "/Users/brook" })).toBe("/Users/brook");
    expect(hostPathOf("~/notes", "/here", "/Users/me", remote)).toBe("/Users/brook/notes");
    expect(hostPathOf("/srv/x/../y", "/here", "/Users/me", remote)).toBe("/srv/y");
    expect(() => hostPathOf("notes", "/here", "/Users/me", remote)).toThrow(TaviError);
    expect(() => hostPathOf("notes", "/here", "/Users/me", remote)).toThrow(/absolute path/);
    expect(clientCwdFor(mirror, "/here")).toEqual({});

    const local = directories.create();
    expect(remoteFoldersOf(local)).toBeUndefined();
    expect(clientCwdFor(local, "/here")).toEqual({ clientCwd: "/here" });
    expect(hostPathOf("~/notes", "/here", "/Users/me")).toBe("/Users/me/notes");
  });
});
