import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SandboxPolicy } from "@tavi/contracts";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createRuntimeSandbox } from "../src/runtime.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/**
 * Real qualification against the actual `@anthropic-ai/sandbox-runtime`
 * library and real macOS Seatbelt enforcement — no injected `manager` or
 * `spawn`, unlike every other test in this package (see `runtime.ts`'s own
 * header comment on why that separation exists). Skipped on every
 * non-macOS platform, and on macOS when this shell is already inside an
 * outer sandbox (see `canApplySeatbeltProfile` in `@tavi/test-support/sandbox`); this repo has no CI
 * today, so this
 * file exists purely for a real macOS host — this one included.
 *
 * This file exists because a real macOS run of the adapter surfaced a
 * genuine, previously-unverifiable bug: macOS Seatbelt's `(subpath ...)`
 * filters match the kernel-resolved (symlink-canonical) path an `open()`
 * call actually targets, not the caller's literal spelling. `/etc` is
 * itself a symlink to `/private/etc` on macOS, so a policy path spelled
 * `/etc/hosts` never matched what the kernel evaluated — `denyPaths:
 * ["/etc/hosts"]` silently failed to block `cat /etc/hosts`. Fixed by
 * `runtime.ts`'s `canonicalize()`.
 *
 * Only the FIRST test below is a regression test for that specific fix.
 * The other two are general real-Seatbelt-enforcement sanity checks
 * (allow/deny precedence over a `os.tmpdir()`-rooted path, which the
 * vendor library already canonicalizes correctly on its own independent
 * of this adapter's fix — see `canonicalize`'s own doc comment in
 * `runtime.ts`; and default network denial) — real coverage this package
 * had none of before, but not specifically pinning the symlink bug.
 */
const nestedSandbox = process.platform === "darwin" && !canApplySeatbeltProfile();
if (nestedSandbox) {
  console.warn(
    "[plugin-sandbox] Skipping the real macOS Seatbelt tests: this shell is already inside a sandbox, so " +
      "`sandbox-exec` cannot apply a nested profile (`sandbox_apply: Operation not permitted`). " +
      "Run `pnpm --filter @tavi/plugin-sandbox test` from an unsandboxed shell to exercise them.",
  );
}

const describeRealSeatbelt = process.platform === "darwin" && !nestedSandbox ? describe : describe.skip;
describeRealSeatbelt("createRuntimeSandbox — real macOS Seatbelt enforcement", () => {
  it("blocks reading a symlink-traversed path named in denyPaths (the confirmed real bug this canonicalizes around)", async () => {
    const sandbox = createRuntimeSandbox();
    expect(sandbox.capabilities().available).toBe(true);

    const policy: SandboxPolicy = {
      filesystem: { allowRead: [], allowWrite: [], denyPaths: ["/etc/hosts"] },
      network: { allow: false },
      resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
    };
    const result = await sandbox.run(policy, { command: "cat", args: ["/etc/hosts"] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("allows reading a path granted by allowRead, and blocks a sibling path that is not", async () => {
    const root = temp.create("tavi-sandbox-real-");
    const allowed = join(root, "allowed.txt");
    const denied = join(root, "denied.txt");
    writeFileSync(allowed, "visible");
    writeFileSync(denied, "secret");

    const sandbox = createRuntimeSandbox();
    const policy: SandboxPolicy = {
      filesystem: { allowRead: [allowed], allowWrite: [], denyPaths: [root] },
      network: { allow: false },
      resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
    };
    const allowedResult = await sandbox.run(policy, { command: "cat", args: [allowed] });
    expect(allowedResult.exitCode).toBe(0);
    expect(allowedResult.stdout).toBe("visible");

    const deniedResult = await sandbox.run(policy, { command: "cat", args: [denied] });
    expect(deniedResult.exitCode).not.toBe(0);
    expect(deniedResult.stdout).toBe("");
  });

  it("with inheritEnv: false, the sandboxed command never sees the caller's environment", async () => {
    process.env["TAVI_SANDBOX_REAL_SECRET"] = "owner-secret-value";
    try {
      const sandbox = createRuntimeSandbox();
      const policy: SandboxPolicy = {
        filesystem: { allowRead: [], allowWrite: [] },
        network: { allow: false },
        resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
      };
      const inherited = await sandbox.run(policy, { command: "/usr/bin/env" });
      expect(inherited.stdout).toContain("owner-secret-value");
      const isolated = await sandbox.run(policy, { command: "/usr/bin/env", env: { ONLY: "this" }, inheritEnv: false });
      expect(isolated.exitCode).toBe(0);
      expect(isolated.stdout).toContain("ONLY=this");
      expect(isolated.stdout).not.toContain("owner-secret-value");
    } finally {
      delete process.env["TAVI_SANDBOX_REAL_SECRET"];
    }
  });

  it("unsets a denyEnv variable in the child even when the caller's environment is inherited", async () => {
    process.env["TAVI_SANDBOX_REAL_SECRET"] = "owner-secret-value";
    try {
      const sandbox = createRuntimeSandbox();
      const policy: SandboxPolicy = {
        filesystem: { allowRead: [], allowWrite: [] },
        network: { allow: false },
        resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
      };
      const result = await sandbox.run(policy, { command: "/usr/bin/env", denyEnv: ["TAVI_SANDBOX_REAL_SECRET"] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("owner-secret-value");
    } finally {
      delete process.env["TAVI_SANDBOX_REAL_SECRET"];
    }
  });

  it("blocks outbound network access by default, with no unlimited-access escape hatch", async () => {
    // A closed port (e.g. 127.0.0.1:1) fails identically with or without
    // sandboxing — `curl: (7) Couldn't connect` either way — so it proves
    // nothing about enforcement. A real listener is required: this starts
    // one from the test process itself, confirms it's genuinely reachable
    // un-sandboxed (the control), then asserts the sandboxed `curl` cannot
    // reach that same listener.
    const server: Server = createServer((_req, res) => res.end("reachable"));
    const url = `http://127.0.0.1:${await listenLocally(server)}/`;
    try {
      const execFileAsync = promisify(execFile);
      // Control: reachable without the sandbox.
      const control = await execFileAsync("curl", ["--max-time", "3", "-sS", url]);
      expect(control.stdout).toBe("reachable");

      const sandbox = createRuntimeSandbox();
      const policy: SandboxPolicy = {
        filesystem: { allowRead: [], allowWrite: [] },
        network: { allow: false },
        resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
      };
      const result = await sandbox.run(policy, { command: "curl", args: ["--max-time", "3", "-sS", url] });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toBe("reachable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
