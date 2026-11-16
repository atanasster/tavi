import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { runtimeSharedWritePaths, type CompileFs } from "../src/policy-compile.js";
import {
  createSrtConfinement,
  nodeReadRoot,
  srtArgs,
  srtCliPath,
  srtEnvironment,
  srtHelpersDirectory,
  srtSettingsOf,
} from "../src/srt-cli.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/** A filesystem with nothing in it: a compile over it changes no spelling. */
const EMPTY_FS: CompileFs = {
  kind: () => undefined,
  list: () => [],
  link: () => undefined,
  read: () => undefined,
  real: () => undefined,
  foldsCase: () => false,
};

describe("the srt CLI seam", () => {
  it("finds the shipped srt CLI and its helpers", () => {
    expect(existsSync(srtCliPath())).toBe(true);
    expect(existsSync(srtHelpersDirectory())).toBe(true);
  });

  it("reads node's install directory unless it holds a denied root", () => {
    expect(nodeReadRoot(["/Users/me", "/data"], "/usr/local/bin/node")).toBe("/usr/local");
    expect(nodeReadRoot(["/Users/me"], "/Users/me/.nvm/versions/node/v22/bin/node")).toBe("/Users/me/.nvm/versions/node/v22");
    expect(nodeReadRoot(["/Users/me"], "/Users/bin/node")).toBe("/Users/bin");
  });

  it("writes a strict allowlist, and the nested mode only when asked", () => {
    // Compiled for macOS over an empty filesystem, so every path keeps its spelling.
    const settings = srtSettingsOf(
      { allowedDomains: [], denyRead: ["/home"], allowRead: ["/pkg"], allowWrite: [], nested: false },
      "darwin",
      EMPTY_FS,
    );
    expect(settings).toEqual({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      // srt's own shared write paths closed, as for sandbox.run.
      filesystem: {
        denyRead: ["/home"],
        allowRead: ["/pkg"],
        allowWrite: [],
        denyWrite: [...runtimeSharedWritePaths(homedir(), "darwin")],
      },
    });
    expect(srtSettingsOf({ allowedDomains: [], denyRead: [], allowRead: [], allowWrite: [], nested: true })).toMatchObject({
      enableWeakerNestedSandbox: true,
    });
  });

  it("denies paste sites and private ranges to a child granted domains, and neither to one that may reach every host (the browser)", () => {
    const granted = srtSettingsOf(
      { allowedDomains: ["example.com"], denyRead: [], allowRead: [], allowWrite: [], nested: false },
      "linux",
      EMPTY_FS,
    );
    expect(granted.network).toMatchObject({
      allowedDomains: ["example.com"],
      deniedDomains: expect.arrayContaining(["pastebin.com", "*.webhook.site"]),
      deniedDomainReasons: expect.objectContaining({ "pastebin.com": expect.stringContaining("paste") }),
      deniedResolvedAddresses: expect.arrayContaining(["10.0.0.0/8", "192.168.0.0/16", "fc00::/7"]),
    });
    const everyHost = srtSettingsOf(
      { allowedDomains: ["*"], denyRead: [], allowRead: [], allowWrite: [], nested: false },
      "linux",
      EMPTY_FS,
    );
    expect(everyHost.network.deniedDomains).toEqual([]);
    expect(everyHost.network.deniedResolvedAddresses).toBeUndefined();
    expect(
      srtSettingsOf({ allowedDomains: [], denyRead: [], allowRead: [], allowWrite: [], nested: false }, "linux", EMPTY_FS).network,
    ).toEqual({ allowedDomains: [], deniedDomains: [], strictAllowlist: true });
  });

  it("refuses to start a confined child off macOS and Linux, writing no policy", () => {
    const directory = temp.create("tavi-srt-cli-");
    const policyFile = join(directory, "srt.json");
    expect(() =>
      createSrtConfinement({ platform: "win32" }).wrap({
        argv: ["node", "worker.mjs"],
        env: {},
        policyFile,
        policy: { denyRead: [], allowRead: [], allowWrite: [], domains: [], nested: false },
      }),
    ).toThrowError(expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringMatching(/WSL2/) }));
    expect(existsSync(policyFile)).toBe(false);
  });

  it("denies the browser private and CGNAT addresses, by name and by number, except the operator's listed addresses", () => {
    const directory = temp.create("tavi-srt-cli-");
    const policyFile = join(directory, "srt.json");
    createSrtConfinement().wrap({
      argv: ["/usr/bin/node", "/opt/shim.mjs", "/opt/chrome"],
      env: { HOME: "/scratch", TMPDIR: "/scratch/.tmp", PATH: "/usr/bin" },
      policyFile,
      policy: {
        denyRead: [],
        allowRead: ["/scratch"],
        allowWrite: ["/scratch"],
        domains: ["*"],
        nested: false,
        privateAddresses: { except: ["192.168.1.20", "10.0.0.5:8080"] },
      },
    });
    const request = JSON.parse(readFileSync(policyFile, "utf8")) as {
      privateAddresses?: { except: string[] };
      config: { network: { deniedResolvedAddresses?: string[] } };
    };
    // srt's resolved-address guard drops a private answer and dials what it checked; the ask callback refuses a private literal.
    expect(request.config.network.deniedResolvedAddresses).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"]),
    );
    expect(request.privateAddresses).toEqual({ except: ["192.168.1.20", "10.0.0.5:8080"] });
  });

  it("keeps srt's own TMPDIR and hands the child its own inside", () => {
    expect(srtEnvironment({ TMPDIR: "/deep/home/tmp", HOME: "/deep/home" })).toEqual({ HOME: "/deep/home" });
    expect(srtArgs("/s.json", { TMPDIR: "/deep/home/tmp" }, ["/bin/node", "child.mjs"])).toEqual([
      srtCliPath(),
      "--settings",
      "/s.json",
      "--",
      "/usr/bin/env",
      "TMPDIR=/deep/home/tmp",
      "/bin/node",
      "child.mjs",
    ]);
  });

  it("never lets a child's variables configure srt's own proxy, certificates or files, and hands the child the ones it may keep", () => {
    const launch = {
      TMPDIR: "/deep/home/tmp",
      HOME: "/deep/home",
      HTTPS_PROXY: "http://publisher.example:8080",
      https_proxy: "http://publisher.example:8080",
      ALL_PROXY: "socks5://publisher.example:1080",
      NO_PROXY: "*",
      NODE_EXTRA_CA_CERTS: "/deep/home/ca.pem",
      NODE_V8_COVERAGE: "/deep/home/coverage",
      SRT_DEBUG: "1",
    };
    expect(srtEnvironment(launch)).toEqual({ HOME: "/deep/home" });
    expect(srtArgs("/s.json", launch, ["/bin/node", "child.mjs"])).toEqual([
      srtCliPath(),
      "--settings",
      "/s.json",
      "--",
      "/usr/bin/env",
      "TMPDIR=/deep/home/tmp",
      "NODE_EXTRA_CA_CERTS=/deep/home/ca.pem",
      "NODE_V8_COVERAGE=/deep/home/coverage",
      "SRT_DEBUG=1",
      "/bin/node",
      "child.mjs",
    ]);
  });

  it("wraps a launch as a ConfinementPort: the policy written whole, Tavi's node and srt's helpers readable, the owner's staging denied", () => {
    const directory = temp.create("tavi-srt-cli-");
    const policyFile = join(directory, "srt.json");
    const wrapped = createSrtConfinement().wrap({
      argv: ["/bin/node", "child.mjs"],
      env: { TMPDIR: "/nonexistent-tavi-home/x/tmp", HOME: "/nonexistent-tavi-home/x" },
      policyFile,
      policy: {
        denyRead: ["/nonexistent-tavi-home"],
        allowRead: ["/nonexistent-tavi-pkg"],
        allowWrite: ["/nonexistent-tavi-home/x"],
        domains: ["example.com"],
        nested: false,
      },
    });
    expect(wrapped).toEqual({
      command: process.execPath,
      args: srtArgs(policyFile, { TMPDIR: "/nonexistent-tavi-home/x/tmp" }, ["/bin/node", "child.mjs"]),
      env: { HOME: "/nonexistent-tavi-home/x" },
    });
    const settings = JSON.parse(readFileSync(policyFile, "utf8")) as {
      network: { allowedDomains: string[] };
      filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
    };
    expect(settings.network.allowedDomains).toEqual(["example.com"]);
    expect(settings.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        realpathSync(nodeReadRoot(["/nonexistent-tavi-home"])),
        realpathSync(srtHelpersDirectory()),
        "/nonexistent-tavi-pkg",
      ]),
    );
    expect(settings.filesystem.allowWrite).toEqual(["/nonexistent-tavi-home/x"]);
    expect(settings.filesystem.denyRead).toEqual(["/nonexistent-tavi-home"]);
    // The owner's staging is denied to every child, whatever its own policy says.
    createSrtConfinement({ alwaysDenyRead: ["/nonexistent-tavi-staging"] }).wrap({
      argv: ["/bin/true"],
      env: {},
      policyFile,
      policy: { denyRead: [], allowRead: [], allowWrite: [], domains: [], nested: false },
    });
    expect((JSON.parse(readFileSync(policyFile, "utf8")) as { filesystem: { denyRead: string[] } }).filesystem.denyRead).toEqual([
      "/nonexistent-tavi-staging",
    ]);
    // Renamed into place: no staging file is left beside it.
    expect(readdirSync(directory)).toEqual(["srt.json"]);
  });

  it("runs a child that may reach every host in a Tavi srt host process, which srt's CLI refuses, with Unix sockets where asked", () => {
    const directory = temp.create("tavi-srt-every-host-");
    const policyFile = join(directory, "policy.json");
    const wrapped = createSrtConfinement().wrap({
      argv: ["/usr/bin/node", "/opt/shim.mjs", "/opt/chrome"],
      env: { HOME: "/scratch", TMPDIR: "/scratch/.tmp", PATH: "/usr/bin" },
      policyFile,
      policy: {
        denyRead: ["/home/person"],
        allowRead: ["/scratch"],
        allowWrite: ["/scratch"],
        domains: ["*"],
        nested: false,
        unixSockets: ["/scratch"],
      },
    });
    expect(wrapped.command).toBe(process.execPath);
    expect(wrapped.args).toEqual([expect.stringMatching(/host-process\.mjs$/), "--request", policyFile]);
    const request = JSON.parse(readFileSync(policyFile, "utf8")) as {
      grants: string[];
      line: string;
      cwd: string;
      inheritEnv: boolean;
      config: { network: { allowUnixSockets?: string[] } };
    };
    expect(request).toMatchObject({
      grants: ["*"],
      cwd: "/scratch",
      inheritEnv: false,
      config: { network: { allowUnixSockets: ["/scratch"], deniedDomains: [] } },
    });
    expect(request.line).toBe("'/usr/bin/env' 'TMPDIR=/scratch/.tmp' '/usr/bin/node' '/opt/shim.mjs' '/opt/chrome'");
  });
});
