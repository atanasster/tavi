import { execFileSync } from "node:child_process";

import {
  TaviError,
  type SandboxCommand,
  type SandboxCapabilities,
  type SandboxPolicy,
  type SandboxPort,
  type SandboxRunResult,
  type SandboxSessionState,
} from "@tavi/contracts";

/**
 * `SandboxPort` fixture adapter — proves the
 * contract and its call sites (`dispatchSandboxedTool` and whatever calls
 * it) without a real qualified provider. Same role
 * `./fakes.ts`'s fixture `ModelPort` plays for the model contract.
 *
 * Two modes:
 *
 *  - **Default (no-op)**: `capabilities().available` is `false`. `run`
 *    throws — this adapter never silently executes anything, matching
 *    "no unsandboxed fallback" even for its own fixture.
 *  - **Opt-in in-process fixture mode** (`{ mode: "echo" }`):
 *    `capabilities().available` is `true`, and `run` never touches the
 *    filesystem or network — it echoes a deterministic, bounded result
 *    derived from the command/policy, entirely in-process. This is what
 *    lets a caller exercise the full `dispatchSandboxedTool` →
 *    `sandbox.run` → bounded-output path in a test.
 */

export interface FixtureSandboxOptions {
  readonly mode?: "unavailable" | "echo";
  readonly platforms?: readonly string[];
  readonly now?: () => string;
}

interface SessionRecord {
  state: SandboxSessionState;
}

export function createFixtureSandbox(options: FixtureSandboxOptions = {}): SandboxPort {
  const mode = options.mode ?? "unavailable";
  const platforms = options.platforms ?? ["darwin", "linux"];
  let counter = 0;
  const sessions = new Map<string, SessionRecord>();

  const capabilities: SandboxCapabilities = {
    available: mode === "echo",
    platforms,
    // The real adapter's fields, so a caller reading them is exercised here too.
    tier: mode === "echo" ? "full" : "unavailable",
    checks: [],
    ...(mode === "unavailable" ? { detail: 'fixture sandbox is in no-op mode; construct with { mode: "echo" } to enable it' } : {}),
  };

  return {
    capabilities(): SandboxCapabilities {
      return capabilities;
    },

    async run(policy: SandboxPolicy, command: SandboxCommand): Promise<SandboxRunResult> {
      if (mode !== "echo") {
        // Never silently executes — matches "no unsandboxed fallback"
        // even for this fixture's own default state.
        throw new TaviError("UNAVAILABLE", "fixture sandbox is in no-op mode and cannot run commands");
      }
      const sessionId = `sandbox-session-${(counter += 1)}`;
      sessions.set(sessionId, { state: "running" });

      // No filesystem/network access — a deterministic, bounded echo of
      // the command it was asked to run, respecting the policy's own
      // output bound so a caller can exercise real truncation behavior.
      const rendered = [command.command, ...(command.args ?? [])].join(" ");
      const full = `fixture sandbox echoed: ${rendered}`;
      // `maxOutputBytes` is a byte bound, not a character count —
      // `String.slice` counts UTF-16 code units, which overshoots (or
      // splits a surrogate pair) for non-ASCII content. Encode first, the
      // same byte-accurate pattern `boundToolOutput`
      // (`@tavi/contracts`'s `tools.ts`) already uses.
      const fullBytes = new TextEncoder().encode(full);
      const boundedBytes = fullBytes.slice(0, policy.resources.maxOutputBytes);
      const bounded = new TextDecoder().decode(boundedBytes);
      const truncated = boundedBytes.length < fullBytes.length;

      sessions.set(sessionId, { state: "completed" });
      return {
        session: { sessionId, state: "completed" },
        exitCode: 0,
        stdout: bounded,
        stderr: "",
        truncated,
        tier: "full",
        violations: [],
        violationsComplete: true,
      };
    },

    async cancel(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new TaviError("NOT_FOUND", `No sandbox session ${sessionId}`);
      }
      // This branch is structurally unreachable in this fixture: `run`
      // resolves synchronously straight to `"completed"` before a caller
      // can ever obtain a `sessionId` to cancel, so there is no way for
      // this fixture to represent — or for a test to exercise — a session
      // still genuinely `"running"` at the moment `cancel` is called. Kept
      // for interface completeness and in case a future fixture mode adds
      // an artificial delay; the *actually-cancels-something* path is
      // unverified by design, not merely by omission. Only the no-op-on-an-already-completed-session path is
      // exercised today.
      if (session.state === "running") {
        session.state = "cancelled";
      }
    },

    async dispose(sessionId: string): Promise<void> {
      if (!sessions.has(sessionId)) {
        throw new TaviError("NOT_FOUND", `No sandbox session ${sessionId}`);
      }
      sessions.delete(sessionId);
    },
  };
}

/**
 * Whether this process can apply its own Seatbelt profile.
 *
 * macOS refuses to apply a sandbox from inside an existing one, so a shell
 * that is already sandboxed (an agent tool sandbox, a hardened CI runner)
 * makes every real-Seatbelt test fail for a reason that has nothing to do
 * with the adapter: a nested inner policy cannot widen what the outer profile already
 * denies, so a child `allowRead` under a `denyPaths` parent comes back
 * denied. Probing with a trivial *permissive* profile is definitive — an
 * `sandbox-exec` that cannot apply `(allow default)` is inside something —
 * and it is what the earlier "deterministic exit 71" reports were hitting.
 */
export function canApplySeatbeltProfile(): boolean {
  try {
    execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
