import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxPolicy } from "@tavi/contracts";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSandboxHost } from "../src/host.js";
import { hostProcessPath } from "../src/paths.js";
import { compile } from "../src/policy-compile.js";
import { createRuntimeSandbox } from "../src/runtime.js";

/**
 * Network runs through the srt host process, against the
 * real srt: macOS always; Linux in the matrix's `srt` case (its runtime
 * directory from `XDG_RUNTIME_DIR`, which the test sets when absent).
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);

describe.skipIf(MODE !== "srt")(`network runs (${process.platform})`, () => {
  let server: Server;
  let port = 0;
  let root = "";
  let work = "";
  let runtime: string | undefined;
  const temp = temporaryDirectories();
  beforeAll(async () => {
    root = temp.create("tavi-egress-");
    work = join(root, "work");
    mkdirSync(work);
    if (process.platform === "linux" && process.env["XDG_RUNTIME_DIR"] === undefined) {
      // Outside the temporary directory the policy denies, as /run/user/<uid> is.
      runtime = join(homedir(), `.tavi-xdg-${String(process.pid)}`);
      process.env["XDG_RUNTIME_DIR"] = runtime;
      mkdirSync(runtime, { mode: 0o700 });
    }
    server = createServer((_request, response) => response.end("granted-ok"));
    port = await listenLocally(server);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    temp.cleanup();
    if (runtime !== undefined) {
      rmSync(runtime, { recursive: true, force: true });
      delete process.env["XDG_RUNTIME_DIR"];
    }
  });

  const policy = (grants: readonly string[]): SandboxPolicy => ({
    filesystem: { allowRead: [work], allowWrite: [work], denyRead: [tmpdir()] },
    network: { allow: true, allowedHosts: [...grants] },
    resources: { timeoutMs: 30_000, maxOutputBytes: 65_536 },
  });
  /** curl fetches `url` through srt's proxy (it reads the proxy variables srt sets; Node needs 22.21+) and prints the status and body. */
  const fetchLine = (url: string): string => `curl -s -m 10 -w ' %{http_code}\\n' '${url}' || echo failed`;

  it("reaches a granted host through its own proxy, records each request, and refuses what is not granted", async () => {
    const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
    const command = {
      command: "/bin/sh",
      args: ["-c", `${fetchLine("http://example.org/")}; ${fetchLine("http://example.com/")}`],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
    };
    const result = await sandbox.run(policy(["example.org"]), command);
    expect(result.stdout, result.stderr).toMatch(/Example Domain[\s\S]* 200/);
    expect(result.stdout).toContain(" 403");
    expect(result.requests).toEqual(
      expect.arrayContaining([
        { host: "example.org", port: 80, allowed: true, count: 1, allowedCount: 1 },
        { host: "example.com", port: 80, allowed: false, count: 1, allowedCount: 0 },
      ]),
    );
    await sandbox.close?.();
  }, 60_000);

  it.skipIf(process.platform !== "darwin")(
    "leaves nothing running after a networked run, even an Apple binary that forked away with its environment cleared",
    async () => {
      const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
      const marker = `tavi-egress-leftover-${String(process.pid)}`;
      const result = await sandbox.run(policy(["example.org"]), {
        command: "/bin/sh",
        args: [
          "-c",
          `env -i /usr/bin/perl -MPOSIX -e 'fork and exit; setsid; fork and exit; sleep 600' ${marker} >/dev/null 2>&1 & echo started`,
        ],
        cwd: work,
        env: { PATH: process.env["PATH"] ?? "", HOME: work },
        inheritEnv: false,
      });
      try {
        expect(result.stdout, result.stderr).toContain("started");
        expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
      } finally {
        spawnSync("pkill", ["-f", marker]);
        await sandbox.close?.();
      }
    },
    60_000,
  );

  it("inspected, still reaches a granted host over TLS, and refuses a tunnel that carries no TLS", async () => {
    const sandbox = createRuntimeSandbox({
      host: createSandboxHost({ dataDirectory: root }),
      caDirectory: join(root, "inspect-ca"),
      inspectTls: true,
    });
    const result = await sandbox.run(policy(["example.org"]), {
      command: "/bin/sh",
      args: [
        "-c",
        // Plain HTTP inside a CONNECT tunnel (`-p`) is a tunnel the proxy cannot read.
        `${fetchLine("https://example.org/")}; curl -s -m 10 -p -o /dev/null -w 'tunnel %{http_code}\\n' http://example.org/ || echo 'tunnel refused'`,
      ],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
    });
    expect(result.stdout, result.stderr).toMatch(/Example Domain[\s\S]* 200/);
    expect(result.stdout).not.toContain("tunnel 200");
    await sandbox.close?.();
  }, 60_000);

  it.skipIf(process.platform !== "darwin")(
    "reports a networked run's refused write, as an offline run's",
    async () => {
      const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
      const outside = join(root, "outside.txt");
      const result = await sandbox.run(policy(["example.org"]), {
        command: "/bin/sh",
        args: ["-c", `echo x > '${outside}' || echo refused`],
        cwd: work,
        env: { PATH: process.env["PATH"] ?? "", HOME: work },
        inheritEnv: false,
      });
      expect(result.stdout).toContain("refused");
      expect(result.violations, JSON.stringify(result.violations)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "write", target: expect.stringContaining("outside.txt") })]),
      );
      await sandbox.close?.();
    },
    60_000,
  );

  it("refuses a paste site even when it is granted, and audits the refusal", async () => {
    const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
    const result = await sandbox.run(policy(["pastebin.com"]), {
      command: "/bin/sh",
      args: ["-c", fetchLine("http://pastebin.com/")],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
    });
    expect(result.stdout).toContain(" 403");
    expect(result.requests).toEqual([{ host: "pastebin.com", port: 80, allowed: false, count: 1, allowedCount: 0 }]);
    await sandbox.close?.();
  }, 60_000);

  it("answers and exits at once when it cannot start the run, rather than waiting out its timeout", async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "host-process.mjs")], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const control = child.stdio[3] as import("node:stream").Duplex;
    let events = "";
    control.on("data", (chunk: Buffer) => (events += chunk.toString("utf8")));
    control.write("not json\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(70);
    expect(JSON.parse(events.trim().split("\n")[0] ?? "{}")).toMatchObject({ type: "error", message: expect.stringContaining("JSON") });
  }, 10_000);

  it("keeps concurrent runs' grants apart: each has its own proxy", async () => {
    const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
    const run = (granted: string, other: string) =>
      sandbox.run(policy([granted]), {
        command: "/bin/sh",
        args: ["-c", `${fetchLine(`http://${granted}/`)}; ${fetchLine(`http://${other}/`)}`],
        cwd: work,
        env: { PATH: process.env["PATH"] ?? "", HOME: work },
        inheritEnv: false,
      });
    const [first, second] = await Promise.all([run("example.org", "example.com"), run("example.com", "example.org")]);
    expect(first?.requests).toEqual(
      expect.arrayContaining([
        { host: "example.org", port: 80, allowed: true, count: 1, allowedCount: 1 },
        { host: "example.com", port: 80, allowed: false, count: 1, allowedCount: 0 },
      ]),
    );
    expect(second?.requests).toEqual(
      expect.arrayContaining([
        { host: "example.com", port: 80, allowed: true, count: 1, allowedCount: 1 },
        { host: "example.org", port: 80, allowed: false, count: 1, allowedCount: 0 },
      ]),
    );
    await sandbox.close?.();
  }, 60_000);

  it("never dials a granted name that resolves to this host (DNS rebinding)", async () => {
    const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
    // A public name whose address is 127.0.0.1: granted, yet the proxy refuses to dial it.
    const result = await sandbox.run(policy([`localtest.me:${String(port)}`]), {
      command: "/bin/sh",
      args: ["-c", fetchLine(`http://localtest.me:${String(port)}/`)],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
    });
    expect(result.stdout).not.toContain("granted-ok");
    expect(result.stdout).toContain(" 403");
    // Granted, but never dialed: the audit says refused.
    expect(result.requests).toEqual([{ host: "localtest.me", port, allowed: false, count: 1, allowedCount: 0 }]);
    await sandbox.close?.();
  }, 60_000);

  it("never dials this host by an address spelled another way, even for a run that may reach every host (the browser's grant)", async () => {
    const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }) });
    // curl sends an IPv4-mapped literal as written; srt dials it as 127.0.0.1.
    const result = await sandbox.run(policy(["*"]), {
      command: "/bin/sh",
      args: ["-c", fetchLine(`http://[::ffff:7f00:1]:${String(port)}/`)],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
    });
    expect(result.stdout, result.stderr).not.toContain("granted-ok");
    expect(result.stdout).toContain(" 403");
    expect(result.requests).toEqual([{ host: "127.0.0.1", port, allowed: false, count: 1, allowedCount: 0 }]);
    await sandbox.close?.();
  }, 60_000);

  it("on SIGTERM lets its command go, then still cleans up and reports the exit", async () => {
    const config = compile(policy(["example.org"]), {}, process.platform === "linux" ? "linux" : "darwin").config;
    const directory = mkdtempSync(join(process.env["XDG_RUNTIME_DIR"] ?? root, "srt-"));
    const child = spawn(process.execPath, [hostProcessPath()], {
      cwd: work,
      env: { ...process.env, TMPDIR: directory },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as import("node:stream").Duplex;
    let events = "";
    control.on("data", (chunk: Buffer) => (events += chunk.toString("utf8")));
    const started = new Promise<void>((resolve) =>
      child.stdout?.on("data", (chunk: Buffer) => chunk.toString("utf8").includes("started") && resolve()),
    );
    control.write(
      `${JSON.stringify({ config, grants: ["example.org"], line: "echo started; exec sleep 30", cwd: work, env: { PATH: process.env["PATH"] ?? "" }, inheritEnv: false })}\n`,
    );
    await started;
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    // The process alone, as a launcher closing a confined child signals it: its command must not outlive it.
    child.kill("SIGTERM");
    await closed;
    rmSync(directory, { recursive: true, force: true });
    expect(
      events
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toContain("exit");
  }, 15_000);

  describe("credentials", () => {
    const secret = `tavi-test-secret-${String(process.pid)}`;
    const credentialed = (extra: readonly string[] = [], hosts: readonly string[] = ["httpbin.org"]): SandboxPolicy => ({
      ...policy([...hosts, ...extra]),
      network: { allow: true, allowedHosts: [...hosts, ...extra], credentials: [{ env: "TAVI_TEST_TOKEN", hosts: [...hosts] }] },
    });
    const sh = (line: string) => ({
      command: "/bin/sh",
      args: ["-c", line],
      cwd: work,
      env: { PATH: process.env["PATH"] ?? "", HOME: work },
      inheritEnv: false,
      secrets: { TAVI_TEST_TOKEN: secret },
    });
    const sandboxWithCa = () => createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }), caDirectory: join(root, "ca") });

    it("gives the command a placeholder, and the proxy the real value toward the credential's host only", async () => {
      const sandbox = sandboxWithCa();
      const environ = process.platform === "linux" ? "tr '\\0' '\\n' < /proc/self/environ" : "env";
      const result = await sandbox.run(
        credentialed(),
        sh(
          `printf 'seen=%s\\n' "$TAVI_TEST_TOKEN"; ${environ} | grep -c '${secret}' || true; curl -s -m 15 -H "Authorization: Bearer $TAVI_TEST_TOKEN" https://httpbin.org/headers`,
        ),
      );
      expect(result.stdout, result.stderr).toMatch(/^seen=fake_value_/);
      expect(result.stdout.split("\n")[1]).toBe("0");
      // httpbin echoes the header it received: the real value, put in by the proxy.
      expect(result.stdout).toContain(`Bearer ${secret}`);
      expect(result.requests).toContainEqual(
        expect.objectContaining({ host: "httpbin.org", port: 443, allowed: true, credentials: ["TAVI_TEST_TOKEN"] }),
      );
      await sandbox.close?.();
    }, 60_000);

    it("refuses a key of the command's own, a placeholder in the URL, and a GET with a body, toward the credential's host", async () => {
      const sandbox = sandboxWithCa();
      const result = await sandbox.run(
        credentialed(),
        sh(
          `head -c 200000 /dev/zero | tr '\\0' x > body; ${fetchLine("https://httpbin.org/headers' -H 'Authorization: Bearer my-own-key")}; curl -s -m 15 -w ' %{http_code}\\n' "https://httpbin.org/anything?t=$TAVI_TEST_TOKEN"; curl -s -m 15 -w ' %{http_code}\\n' -X GET --data "$TAVI_TEST_TOKEN" https://httpbin.org/anything; curl -s -m 15 -o /dev/null -w 'post=%{http_code}\\n' -H 'Authorization: Bearer my-own-key' --data-binary @body https://httpbin.org/anything`,
        ),
      );
      expect(result.stdout, result.stderr).not.toContain(secret);
      expect(result.stdout.match(/ 403/g)).toHaveLength(3);
      // Refused while it uploads: a 403, or the connection closed under it (curl's 000), never through.
      expect(result.stdout).toMatch(/post=(403|000)/);
      await sandbox.close?.();
    }, 60_000);

    it("sends only the placeholder to any other host, a cross-host redirect included", async () => {
      const sandbox = sandboxWithCa();
      // The credential's host redirects to one without it (httpbin's own redirect now only reaches example.*).
      // The proxy refuses loopback, so a local server cannot play either host.
      const redirect = `https://postman-echo.com/redirect-to?url=${encodeURIComponent("https://httpbin.org/headers")}`;
      const result = await sandbox.run(
        credentialed(["httpbin.org"], ["postman-echo.com"]),
        sh(
          `curl -s -m 15 -H "Authorization: Bearer $TAVI_TEST_TOKEN" https://httpbin.org/headers; echo; curl -s -m 20 -L --location-trusted -H "Authorization: Bearer $TAVI_TEST_TOKEN" '${redirect}'`,
        ),
      );
      expect(result.stdout, result.stderr).not.toContain(secret);
      // Both requests reached httpbin, which echoes the placeholder it got: the direct one and the redirected one.
      expect(result.stdout.match(/Bearer fake_value_/g)?.length, result.stdout).toBe(2);
      // The proxy put the value into the redirecting request only, never into one toward httpbin.
      expect(result.requests).toContainEqual(
        expect.objectContaining({ host: "postman-echo.com", port: 443, allowed: true, credentials: ["TAVI_TEST_TOKEN"] }),
      );
      const echoed = result.requests?.find((request) => request.host === "httpbin.org");
      expect(echoed).toMatchObject({ allowed: true, allowedCount: 2 });
      expect(echoed?.credentials).toBeUndefined();
      await sandbox.close?.();
    }, 60_000);

    it("never sends the value to an upstream whose certificate fails", async () => {
      const sandbox = sandboxWithCa();
      for (const host of ["expired.badssl.com", "wrong.host.badssl.com", "self-signed.badssl.com", "untrusted-root.badssl.com"]) {
        const result = await sandbox.run(
          credentialed([], [host]),
          sh(`curl -s -m 15 -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $TAVI_TEST_TOKEN" https://${host}/ || echo failed`),
        );
        // The proxy answers 502: the upstream's certificate failed, so no request, and no value, was sent.
        expect(result.stdout.trim(), `${host}: ${result.stderr}`).toBe("502");
      }
      await sandbox.close?.();
    }, 120_000);

    it("keeps the CA's key from the command where only the CA's folder is denied, by name, as the owner denies its data directory's entries", async () => {
      // A data directory the command partly reads (its chat's folder), outside the temporary directory the other runs deny.
      const data = join(work, "data");
      const caDirectory = join(data, "sandbox-ca");
      mkdirSync(join(data, "chats"), { recursive: true });
      writeFileSync(join(data, "chats", "note"), "readable");
      const byName: SandboxPolicy = { ...credentialed(), filesystem: { allowRead: [work], allowWrite: [work], denyRead: [caDirectory] } };
      const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: root }), caDirectory });
      await sandbox.run(byName, sh("true"));
      const [folder] = readdirSync(caDirectory);
      const key = join(caDirectory, folder ?? "", "ca.key");
      const result = await sandbox.run(
        byName,
        sh(`cat '${join(data, "chats", "note")}'; echo; cat '${key}' >/dev/null 2>&1 && echo readable || echo refused`),
      );
      expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["readable", "refused"]);
      await sandbox.close?.();
    }, 60_000);
  });
});
