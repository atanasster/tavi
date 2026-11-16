import { dispatchSandboxedTool, type SandboxCommand, type SandboxPolicy, type ToolDefinition } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox } from "../src/sandbox.js";

/**
 * `SandboxPort` fixture adapter and its `dispatchSandboxedTool` gate.
 */

const policy: SandboxPolicy = {
  filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace/out"] },
  network: { allow: false },
  resources: { timeoutMs: 5_000, maxOutputBytes: 64 },
};

const command: SandboxCommand = { command: "echo", args: ["hello"] };

const sandboxedTool: ToolDefinition = {
  id: "fixture.run",
  version: "1.0.0",
  description: "Runs a command through the sandbox",
  effect: "external",
  requiredPermissions: ["tools.invoke"],
  requiresSandbox: true,
};

describe("createFixtureSandbox", () => {
  it("defaults to unavailable, and never runs a command", async () => {
    const sandbox = createFixtureSandbox();
    expect(sandbox.capabilities()).toEqual({
      available: false,
      platforms: ["darwin", "linux"],
      tier: "unavailable",
      checks: [],
      detail: expect.stringContaining("no-op"),
    });
    await expect(sandbox.run(policy, command)).rejects.toThrow(/no-op/);
  });

  it("in echo mode, is available and runs commands in-process with no filesystem/network access", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    expect(sandbox.capabilities().available).toBe(true);
    const result = await sandbox.run(policy, command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo hello");
    expect(result.session.state).toBe("completed");
  });

  it("bounds output to the policy's maxOutputBytes and reports truncation", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const tightPolicy: SandboxPolicy = { ...policy, resources: { ...policy.resources, maxOutputBytes: 10 } };
    const result = await sandbox.run(tightPolicy, command);
    expect(result.stdout.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when the output already fits", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const roomyPolicy: SandboxPolicy = { ...policy, resources: { ...policy.resources, maxOutputBytes: 10_000 } };
    const result = await sandbox.run(roomyPolicy, command);
    expect(result.truncated).toBe(false);
  });

  it("bounds output by UTF-8 bytes, not UTF-16 code units, for non-ASCII content", async () => {
    // "fixture sandbox echoed: echo " is 29 UTF-8 bytes; each 😀 is 4. A
    // bound of 37 (29 + 2*4) lands exactly on a character boundary, so
    // this isolates the UTF-16-vs-byte counting bug from the separate,
    // already-accepted imprecision `boundToolOutput` (`@tavi/contracts`'s `tools.ts`) also has at a
    // mid-character byte boundary (`TextDecoder`'s default lossy
    // replacement can add its own few bytes back) — not this test's
    // concern.
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const wideCommand: SandboxCommand = { command: "echo", args: ["😀😀😀😀😀"] };
    const tightPolicy: SandboxPolicy = { ...policy, resources: { ...policy.resources, maxOutputBytes: 37 } };
    const result = await sandbox.run(tightPolicy, wideCommand);
    expect(result.stdout).toBe("fixture sandbox echoed: echo 😀😀");
    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(37);
    expect(result.truncated).toBe(true);
  });

  it("cancel is a safe no-op once a session has already completed", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const result = await sandbox.run(policy, command);
    await expect(sandbox.cancel(result.session.sessionId)).resolves.toBeUndefined();
  });

  it("cancel on an unknown session throws NOT_FOUND", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    await expect(sandbox.cancel("no-such-session")).rejects.toThrow(/No sandbox session/);
  });

  it("dispose removes a session, and a second dispose throws NOT_FOUND", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const result = await sandbox.run(policy, command);
    await expect(sandbox.dispose(result.session.sessionId)).resolves.toBeUndefined();
    await expect(sandbox.dispose(result.session.sessionId)).rejects.toThrow(/No sandbox session/);
  });
});

describe("dispatchSandboxedTool", () => {
  it("throws NOT_CONFIGURED when no sandbox is configured at all — never runs unsandboxed", async () => {
    await expect(dispatchSandboxedTool(sandboxedTool, undefined, policy, command)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("throws UNAVAILABLE (distinct from NOT_CONFIGURED) when a sandbox is configured but reports itself unavailable", async () => {
    // A configured-but-unavailable sandbox is a different operator-facing
    // situation than nothing being wired up at all — pins that distinction.
    const sandbox = createFixtureSandbox(); // default no-op mode
    await expect(dispatchSandboxedTool(sandboxedTool, sandbox, policy, command)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("names the unavailable sandbox's cause and fix in the refusal itself", async () => {
    const sandbox = {
      ...createFixtureSandbox(),
      capabilities: () => ({
        available: false,
        platforms: ["linux"],
        tier: "unavailable" as const,
        detail: "Ubuntu's AppArmor limits unprivileged user namespaces",
        fix: "tavi sandbox setup",
      }),
    };
    const refusal = dispatchSandboxedTool(sandboxedTool, sandbox, policy, command);
    await expect(refusal).rejects.toThrow(/Ubuntu's AppArmor limits unprivileged user namespaces; fix: tavi sandbox setup/);
    await expect(refusal).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { detail: "Ubuntu's AppArmor limits unprivileged user namespaces", fix: "tavi sandbox setup" },
    });
  });

  it("dispatches through the sandbox when one is configured and available", async () => {
    const sandbox = createFixtureSandbox({ mode: "echo" });
    const result = await dispatchSandboxedTool(sandboxedTool, sandbox, policy, command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo hello");
  });

  it("refuses a tool that does not declare requiresSandbox, rather than silently gating it", async () => {
    const plainTool: ToolDefinition = { ...sandboxedTool, id: "fixture.plain", requiresSandbox: undefined };
    const sandbox = createFixtureSandbox({ mode: "echo" });
    await expect(dispatchSandboxedTool(plainTool, sandbox, policy, command)).rejects.toThrow(/does not declare requiresSandbox/);
  });
});
