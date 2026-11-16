import { LIMITS_ENTRY_FAILED, LIMITS_ENTRY_FAILED_EXIT, PluginManifestSchema, type ResourceLimitPort } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { stdioLaunch } from "../../src/features/mcp/launcher.js";
import { TaviStdioTransport } from "../../src/features/mcp/stdio-transport.js";
import { ownerConfinement } from "../../src/features/sandbox/host.js";

/** An MCP server's resource limits: a cgroup per process the transport starts, released on its exit. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** The errors a transport reports until its process has exited. */
async function exitReport(transport: TaviStdioTransport): Promise<string[]> {
  const errors: string[] = [];
  transport.onerror = (error) => void errors.push(error.message);
  const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
  await transport.start();
  await closed;
  return errors;
}

describe("an MCP stdio server's cgroup", () => {
  it("is placed for each start and released when that process exits, or fails to spawn", async () => {
    const events: string[] = [];
    let starts = 0;
    const place = (argv: readonly string[]) => {
      starts += 1;
      const id = `g${String(starts)}`;
      events.push(`place ${id} ${argv.join(" ")}`);
      return { argv, onExit: () => void events.push(`release ${id}`) };
    };
    for (let round = 0; round < 2; round += 1) {
      // A reconnect builds another transport from the same options: each start has its own group.
      const transport = new TaviStdioTransport({
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
        env: {},
        place,
      });
      await transport.start();
      await transport.close();
    }
    expect(events).toEqual([
      `place g1 ${process.execPath} -e process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`,
      "release g1",
      expect.stringMatching(/^place g2 /),
      "release g2",
    ]);
    const failed = new TaviStdioTransport({ command: "/nonexistent/tavi-mcp-server", args: [], env: {}, place });
    await expect(failed.start()).rejects.toThrow();
    expect(events.at(-1)).toBe("release g3");
  }, 30_000);

  it("reports an OOM kill as one, read from its cgroup, not as a bare crash", async () => {
    const data = directories.create("tavi-mcp-limits-");
    const calls: string[] = [];
    const limits: ResourceLimitPort = {
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      // The server stands in for one the kernel ended: it exits at once, and its group says why.
      place: () => ({ argv: [process.execPath, "-e", "process.exit(137)"], groupId: "g1" }),
      kill: () => undefined,
      outcome: (id) => (calls.push(`outcome ${id}`), "oom"),
      release: (id) => void calls.push(`release ${id}`),
    };
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "mcp-dir", packages: [] },
      id: "mcp.oom",
      version: "1.0.0",
      name: "mcp.oom",
      mcp: { abi: "tavi.mcp/1", transport: "stdio", command: ["node", "${package}/server.mjs"] },
    });
    const spawn = stdioLaunch(
      { pluginId: "mcp.oom", manifest, pluginDirectory: data, sandboxState: "none", env: {} },
      { dataDirectory: data, confinement: ownerConfinement(), limits },
    );
    const errors = await exitReport(new TaviStdioTransport(spawn));
    expect(errors).toContainEqual(expect.stringMatching(/exited \(code 137\): it ran out of memory/));
    // Read before the group is released.
    expect(calls).toEqual(["outcome g1", "release g1"]);
  }, 30_000);

  it("says a process that could not enter its cgroup never ran", async () => {
    const script = `process.stderr.write(${JSON.stringify(`${LIMITS_ENTRY_FAILED} /sys/fs/cgroup/x\n`)}, () => process.exit(${String(LIMITS_ENTRY_FAILED_EXIT)}))`;
    const errors = await exitReport(
      new TaviStdioTransport({ command: process.execPath, args: ["-e", script], env: {}, place: (argv) => ({ argv }) }),
    );
    expect(errors).toContainEqual(expect.stringMatching(/could not enter its resource limits/));
  }, 30_000);
});
