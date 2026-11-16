import { cpSync } from "node:fs";
import { join } from "node:path";

import type { PluginView } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { pluginDetail } from "../../src/features/plugins/client.js";
import { capture } from "../support/attached-owner.js";

/** What `tavi plugins install|validate|show` print: one story, counted in words, with a command that works. */

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "..", "examples");
const dirs = temporaryDirectories();
afterEach(() => dirs.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

function example(path: string): string {
  const source = dirs.create("tavi-plugins-text-src-");
  cpSync(join(EXAMPLES, path), source, { recursive: true });
  return source;
}

describe("tavi plugins install", () => {
  it("names --in-process in its hint for a plugin that cannot be a worker, and that command approves it", async () => {
    const dataDir = dirs.create("tavi-plugins-text-");
    const installed = await tavi(["plugins", "install", example("plugins/acme-ideas"), "--data-dir", dataDir]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    expect(installed.stdout).toContain("approve it with `tavi plugins approve acme.ideas 0.1.0 --in-process`");
    expect(installed.stdout).toContain("unsandboxed");
    const approved = await tavi(["plugins", "approve", "acme.ideas", "0.1.0", "--in-process", "--data-dir", dataDir]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
  });

  it("gives the plain approve command for one that runs as a worker", async () => {
    const dataDir = dirs.create("tavi-plugins-text-");
    const installed = await tavi(["plugins", "install", example("plugins/acme-units"), "--data-dir", dataDir]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    expect(installed.stdout).toBe("installed acme.units@0.1.0 (proposed); approve it with `tavi plugins approve acme.units 0.1.0`\n");
  });
});

describe("tavi plugins validate", () => {
  it("accepts --data-dir, as every plugins action does, and needs none", async () => {
    const validated = await tavi(["plugins", "validate", example("plugins/acme-units"), "--data-dir", dirs.create("tavi-plugins-text-")]);
    expect(validated.stderr).toBe("");
    expect(validated.code).toBe(EXIT.ok);
    expect(validated.stdout).toMatch(/\nvalid\n$/);
  });
});

const base: PluginView = {
  id: "acme.guard",
  kind: "external",
  name: "Guard",
  description: "",
  enabled: false,
  core: false,
  versions: [
    {
      version: "0.1.0",
      reviewState: "proposed",
      contentHash: "a".repeat(64),
      installedAt: "2026-11-03T16:25:10.917Z",
      runsOwnerCode: true,
      tools: [],
      configFields: {},
    },
  ],
  directory: "/data/plugins/acme.guard",
  runsOwnerCode: true,
  tools: [],
  configFields: {},
  config: {},
  phase: "not_composed",
};

describe("tavi plugins show", () => {
  it("says a plugin not loaded is not loaded, names empty lists, and puts its files above its versions", () => {
    const text = pluginDetail(base);
    expect(text).toContain("state: disabled, not loaded in the running owner\n");
    expect(text).not.toContain("not_composed");
    expect(text).toContain("tools: none\n");
    expect(text).toContain("settings: none\n");
    expect(text).toContain("files: /data/plugins/acme.guard/<version>\nversions:\n  0.1.0\tproposed\t");
    expect(text).toContain("installed 2026-11-03 16:25 UTC");
    expect(pluginDetail({ ...base, enabled: true })).toContain("state: enabled, not loaded yet (restart `tavi serve` to load it)\n");
  });

  it("wraps a long description and the network domains at word boundaries to the terminal's columns", () => {
    const description = "Watches Hacker News, Bluesky, Mastodon and Reddit for the topics you name, and tells you whether one is spiking.";
    const domains = Array.from({ length: 12 }, (_, index) => `api${String(index)}.example.org`);
    const plugin: PluginView = { ...base, description, versions: [{ ...base.versions[0]!, networkDomains: domains }] };
    for (const [columns, width] of [
      [undefined, 80],
      [50, 50],
    ] as const) {
      const text = pluginDetail(plugin, columns);
      for (const line of text.split("\n").filter((row) => !row.includes("\t"))) expect(line.length, line).toBeLessThanOrEqual(width);
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain(`description: ${description}`);
      expect(flat).toContain(`network domains: ${domains.join(", ")}`);
    }
  });

  it("counts hook activity and hook time in words, with a time a person reads", () => {
    const text = pluginDetail({
      ...base,
      phase: "ready",
      mods: [{ event: "tool.check", onFailure: "ask", disclosure: "Asks.", reads: "Sees the input of `sandbox.run`." }],
      hookLatency: [{ event: "tool.check", medianMs: 5, worstMs: 5, samples: 1 }],
      hookActivity: {
        decisions: 1,
        failures: 0,
        recent: [
          {
            pluginId: "acme.guard",
            kind: "decision",
            event: "tool.check",
            tool: "sandbox.run",
            detail: "ask → ask: This command deletes files recursively.",
            at: "2026-11-03T16:30:42.418Z",
          },
        ],
      },
    });
    expect(text).toContain("tool.check: median 5 ms, worst 5 ms over its last call\n");
    expect(text).toContain("hook activity: 1 decision, 0 failures\n");
    expect(text).toContain("  2026-11-03 16:30 UTC\tdecision\ttool.check sandbox.run\t");
    expect(pluginDetail({ ...base, hookLatency: [{ event: "tool.check", medianMs: 5, worstMs: 9, samples: 3 }], mods: [] })).toContain(
      "over its last 3 calls",
    );
  });

  it("tells a --dev-plugin folder's one story: loaded from the folder, nothing approved or installed", () => {
    const text = pluginDetail({
      ...base,
      enabled: true,
      dev: true,
      phase: "ready",
      directory: "/home/me/tavi-plugins/acme-tip",
      activeVersion: "0.1.0",
      versions: [{ ...base.versions[0]!, reviewState: "approved" }],
    });
    expect(text).toContain(
      "versions:\n  0.1.0\tdev\tloaded from /home/me/tavi-plugins/acme-tip\truns UNSANDBOXED in the owner's process (--dev-plugin)\n",
    );
    expect(text).not.toMatch(/\tapproved|installed|approve it again/);
  });
});
