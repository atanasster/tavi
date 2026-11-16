import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { nowTimestamp } from "@tavi/contracts/util";
import { createIpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { listCredentialRefs } from "../../src/features/credentials/store.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner } from "../../src/server/serve.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `tavi models|credentials|agents|projects|schedules` under a live owner:
 * dispatched over IPC with the offline output and exit codes, and an
 * action with no IPC counterpart refused with its reason rather than failing on
 * the ownership lock.
 */

const owners = useAttachedOwners("tavi-config-");
/** Directories a test made itself, removed once every owner in them has stopped. */
const ownDirectories = temporaryDirectories();
afterAll(() => ownDirectories.cleanup());

/** Run a command, returning its exit code and output. */
async function tavi(argv: readonly string[], isTty = false) {
  const out = capture(isTty);
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

describe("tavi models under a live owner", ATTACHED, () => {
  it("turns native video on for a model over IPC only with the disclosure confirmed", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", directory];
    const config = handle.runtime.store.asPort().repositories.modelConfig;
    expect((await tavi(["models", "add", "vllm", "--base-url", "http://127.0.0.1:9/v1", "--credential", "vllm.key", ...at])).code).toBe(
      EXIT.ok,
    );
    await config.putCatalogEntry({
      connectionId: "vllm",
      modelId: "qwen3-vl",
      provenance: "live",
      state: "available",
      capabilities: ["video-probed"],
    });
    const unconfirmed = await tavi(["models", "video", "vllm", "--enable", "qwen3-vl", ...at]);
    expect(unconfirmed.code).not.toBe(EXIT.ok);
    expect(unconfirmed.stderr).toContain("sends the whole clip");
    expect((await config.getConnection("vllm"))?.videoModels).toBeUndefined();
    // The canvas reads the disclosure from the refusal's details, to show it and ask before it confirms.
    const live = await findLiveOwner(directory);
    if (live === undefined) throw new Error("no live owner");
    const client = await createIpcClient(live);
    try {
      const asked = await client.request(
        "models",
        { action: "video", connectionId: "vllm", videoEnable: "qwen3-vl", disclosureConfirmed: false },
        `video-${String(Date.now())}`,
      );
      expect(asked).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT", details: { disclosure: expect.stringContaining("sends the whole clip") } },
      });
      // Settings → Models' Video analysers card reads doctor's `video` section here, since a page may not read `doctor`.
      const status = await client.request("models", { action: "video-status" }, `video-status-${String(Date.now())}`);
      expect(status).toMatchObject({
        ok: true,
        result: { enabled: expect.any(Boolean), ffmpeg: expect.any(String), analyzers: { chains: expect.any(Object) } },
      });
    } finally {
      await client.close();
    }
    const confirmed = await tavi(["models", "video", "vllm", "--enable", "qwen3-vl", "--yes", ...at]);
    expect(confirmed.code, confirmed.stderr).toBe(EXIT.ok);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ connectionId: "vllm", videoModels: ["qwen3-vl"] });
    expect((await config.getConnection("vllm"))?.videoModels).toEqual(["qwen3-vl"]);
    // The video probe goes to the owner, the video one: with no credential bound it sends nothing, and its token stays.
    const probed = await tavi(["models", "probe", "vllm", "--video", "--model", "qwen3-vl", ...at]);
    expect(probed.code).not.toBe(EXIT.ok);
    expect(`${probed.stdout}${probed.stderr}`).toContain("the probe sent nothing");
    expect((await config.listCatalog("vllm")).find((entry) => entry.modelId === "qwen3-vl")?.capabilities).toContain("video-probed");
  });

  it("reads and writes the owner's configuration, printing what the offline command prints", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", directory];
    const config = handle.runtime.store.asPort().repositories.modelConfig;

    const added = await tavi([
      "models",
      "add",
      "local",
      "--base-url",
      "http://127.0.0.1:9/v1",
      "--credential",
      "local.key",
      "--model",
      "m1",
      ...at,
    ]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    expect(JSON.parse(added.stdout)).toMatchObject({ connectionId: "local", credentialRef: "local.key", defaultModel: "m1" });
    expect((await config.getConnection("local"))?.baseUrl).toBe("http://127.0.0.1:9/v1");

    const listed = await tavi(["models", "list", ...at]);
    expect(listed.code).toBe(EXIT.ok);
    expect(listed.stdout).toContain('"local"');

    const rebound = await tavi(["models", "rebind", "local", "--credential", "local.other", ...at]);
    expect(rebound.code, rebound.stderr).toBe(EXIT.ok);
    expect((await config.getConnection("local"))?.credentialRef).toBe("local.other");

    const role = await tavi(["models", "set-role", "extraction", "--connection", "local", "--fallback", "local/m2", ...at]);
    expect(role.code, role.stderr).toBe(EXIT.ok);
    expect(JSON.parse(role.stdout)).toMatchObject({ role: "extraction", fallback: [{ connectionId: "local", model: "m2" }] });
    const cleared = await tavi(["models", "clear-role", "extraction", ...at]);
    expect(cleared.stdout.trim()).toBe('{"cleared":"extraction"}');

    // An owner started with --connection and --model keeps its target: no restart is needed.
    const defaulted = await tavi(["models", "set-default", "--connection", "local", ...at]);
    expect(defaulted.code, defaulted.stderr).toBe(EXIT.ok);
    expect(defaulted.stderr).not.toContain("restart");
    expect((await tavi(["models", "clear-default", ...at])).stdout.trim()).toBe('{"cleared":"default"}');

    // A probe resolves the credential through the owner's chain, which holds
    // none for it: a failed test, recorded, exit 1 — as offline without a file.
    const tested = await tavi(["models", "test", "local", ...at]);
    expect(tested.code).toBe(EXIT.taskFailed);
    expect(JSON.parse(tested.stdout)).toMatchObject({ ok: false });
    const filed = await tavi(["models", "test", "local", "--credential-file", "/nowhere", ...at]);
    expect(filed.code).toBe(EXIT.usage);
    expect(filed.stderr).toContain("--credential-file cannot apply");

    const unknownRole = await tavi(["models", "set-role", "nonsense", "--connection", "local", ...at]);
    expect(unknownRole.code).toBe(EXIT.usage);
    expect((await tavi(["models", "show", "nowhere", ...at])).code).toBe(EXIT.unavailable);

    // The recorded test is a catalog entry that still references it: a conflict
    // with stored configuration, a usage-level refusal as offline.
    const referenced = await tavi(["models", "remove", "local", ...at]);
    expect(referenced.code).toBe(EXIT.usage);
    expect(referenced.stderr).toContain("still referenced");

    await tavi(["models", "add", "spare", "--base-url", "http://127.0.0.1:9/v1", "--credential", "spare.key", ...at]);
    const removed = await tavi(["models", "remove", "spare", ...at]);
    expect(removed.code, removed.stderr).toBe(EXIT.ok);
    expect(removed.stdout.trim()).toBe('{"removed":"spare"}');
    expect(await config.getConnection("spare")).toBeUndefined();
  });
});

describe("tavi credentials under a live owner", ATTACHED, () => {
  it("stores, lists and deletes through the owner, never echoing a value", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", directory];
    const file = join(owners.tempDirectory(), "key");
    writeFileSync(file, "sk-secret-value\n");
    chmodSync(file, 0o600);

    const stored = await tavi(["credentials", "set", "openai.apiKey", "--file", file, ...at]);
    expect(stored.code, stored.stderr).toBe(EXIT.ok);
    expect(stored.stdout).toBe("stored credential openai.apiKey\n");
    expect(stored.stdout + stored.stderr).not.toContain("sk-secret-value");
    expect((await listCredentialRefs(directory)).valid).toContain("openai.apiKey");

    const listed = await tavi(["credentials", "list", ...at]);
    expect(listed.stdout).toBe("openai.apiKey\n");

    // The file checks still apply on this side, with the offline exit codes: a
    // readable-by-others file is not authorized (4), a missing one a mistake (2).
    chmodSync(file, 0o644);
    const loose = await tavi(["credentials", "set", "openai.other", "--file", file, ...at]);
    expect(loose.code).toBe(EXIT.unavailable);
    expect((await listCredentialRefs(directory)).valid).not.toContain("openai.other");
    expect((await tavi(["credentials", "set", "openai.other", "--file", "/nowhere/key", ...at])).code).toBe(EXIT.usage);

    // A connection still naming the key is said, and how to give it one again.
    await tavi(["models", "add", "named", "--base-url", "https://api.example.test/v1", "--credential", "openai.apiKey", ...at]);
    const deleted = await tavi(["credentials", "delete", "openai.apiKey", ...at]);
    expect(deleted.stdout).toBe("deleted credential openai.apiKey\n");
    expect(deleted.stderr).toContain(
      "the model connection named still names openai.apiKey: store it again with `tavi credentials set openai.apiKey --file <path>`",
    );
    expect((await listCredentialRefs(directory)).valid).toEqual([]);
  });
});

describe("the offline output, attached", ATTACHED, () => {
  it("prints the same JSON for a read on either path", async () => {
    const directory = owners.tempDirectory();
    const at = ["--data-dir", directory];
    for (const argv of [
      ["agents", "add", "writer", "--name", "Writer", "--prompt", "Write."],
      ["projects", "add", "acme", "--name", "Acme", "--keyword", "acme"],
      ["schedules", "add", "--name", "nightly", "--at", "09:00", "--timezone", "UTC", "--prompt", "say done"],
      ["models", "add", "local", "--base-url", "http://127.0.0.1:9/v1", "--credential", "local.key", "--model", "m1"],
    ]) {
      const seeded = await tavi([...argv, ...at]);
      expect(seeded.code, seeded.stderr).toBe(EXIT.ok);
    }
    const reads = [
      ["agents", "show", "writer", "--format", "json"],
      ["projects", "show", "acme", "--format", "json"],
      ["schedules", "show", "nightly", "--format", "json"],
      ["models", "show", "local"],
      ["models", "roles"],
      ["credentials", "list", "--format", "json"],
    ];
    const offline = [];
    for (const argv of reads) offline.push(await tavi([...argv, ...at]));
    await owners.startOwner(turns([]), { directory });
    for (const [index, argv] of reads.entries()) {
      const attached = await tavi([...argv, ...at]);
      expect(attached.code, argv.join(" ")).toBe(EXIT.ok);
      const result = JSON.parse(attached.stdout) as Record<string, unknown>;
      if (argv[0] === "models" && argv[1] === "roles") {
        expect(result["activeTarget"]).toEqual({ connectionId: "fixture-conn", model: "fixture-model" });
        // Started with its target named by flags: a restart runs the same one.
        expect(result["restartTarget"]).toEqual({ connectionId: "fixture-conn", model: "fixture-model" });
        expect(result["restartRequired"]).toBe(false);
        delete result["activeTarget"];
        delete result["restartTarget"];
        delete result["restartRequired"];
      }
      expect(result, argv.join(" ")).toEqual(JSON.parse(offline[index]?.stdout ?? ""));
    }
  });

  it("says when the owner's bounded list leaves rows out", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const projects = handle.runtime.store.asPort().repositories.projects;
    for (let index = 0; index < 101; index += 1) {
      await projects.create({ workspaceId: "default", project: { id: `p-${index}` }, enabled: true, now: nowTimestamp() });
    }
    const listed = await tavi(["projects", "list", "--data-dir", directory]);
    expect(listed.stdout.trim().split("\n")).toHaveLength(100);
    expect(listed.stderr).toContain("note: the owner lists the first 100 projects");
  });
});

describe("tavi agents and projects under a live owner", ATTACHED, () => {
  it("reads and mutates agents over owner IPC", async () => {
    const directory = owners.tempDirectory();
    const seeded = await tavi([
      "agents",
      "add",
      "writer",
      "--name",
      "Writer",
      "--prompt",
      "Write plainly.\nBe brief.",
      "--data-dir",
      directory,
    ]);
    expect(seeded.code, seeded.stderr).toBe(EXIT.ok);
    await owners.startOwner(turns([]), { directory });
    const at = ["--data-dir", directory];

    const listed = await tavi(["agents", "list", ...at]);
    expect(listed.code, listed.stderr).toBe(EXIT.ok);
    expect(listed.stdout).toMatch(/^writer\tWriter\tenabled/);
    const shown = await tavi(["agents", "show", "writer", ...at]);
    expect(shown.stdout).toContain("    Be brief.");
    expect((await tavi(["agents", "show", "nobody", ...at])).code).toBe(EXIT.usage);

    const added = await tavi(["agents", "add", "editor", "--name", "Editor", "--prompt", "Edit.", ...at]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    expect((await tavi(["agents", "show", "editor", ...at])).stdout).toContain("Edit.");
    expect((await tavi(["agents", "update", "editor", "--prompt", "Edit carefully.", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["agents", "show", "editor", ...at])).stdout).toContain("Edit carefully.");
  });

  it("configures and tests search providers over IPC, offering web_search from the first one with no restart", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", directory];
    const searches: string[] = [];
    const instance = createServer((request, response) => {
      searches.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [{ title: "Tavi", url: "https://tavi.example/", content: "an orchestrator" }] }));
    });
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = instance.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Written by the owner, into its own store; this owner started with no
      // provider, and offers web_search from this one on — no restart, no note.
      expect(handle.runtime.tools.get("web_search")).toBeUndefined();
      const added = await tavi(["search", "add", "home", "--kind", "searxng", "--base-url", baseUrl, ...at]);
      expect(added.code, added.stderr).toBe(EXIT.ok);
      expect(added.stdout).toBe(`home\tsearxng\t${baseUrl}\tenabled\n`);
      expect(added.stderr).not.toContain("restart");
      expect(handle.runtime.tools.get("web_search")).toBeDefined();
      expect((await handle.runtime.store.asPort().repositories.searchProviders.get("home"))?.baseUrl).toBe(baseUrl);

      expect((await tavi(["search", "list", ...at])).stdout).toBe(`home\tsearxng\t${baseUrl}\tenabled\n`);
      const tested = await tavi(["search", "test", "home", "--query", "tavi orchestrator", ...at]);
      expect(tested.code, tested.stderr).toBe(EXIT.ok);
      expect(tested.stdout).toBe("home answered 1 result(s)\n  Tavi\n    https://tavi.example/\n");
      expect(searches).toEqual(["/search?q=tavi+orchestrator&format=json"]);

      const disabled = await tavi(["search", "disable", "home", ...at]);
      expect(disabled.stdout).toBe(`home\tsearxng\t${baseUrl}\tdisabled\n`);
      expect(disabled.stderr).toBe("");

      // Refused as offline: a configuration that cannot work, one that exists, one that does not.
      const keyless = await tavi(["search", "add", "brave", "--kind", "brave", ...at]);
      expect(keyless.code).toBe(EXIT.usage);
      expect(keyless.stderr).toContain("a brave provider needs a credentialRef");
      expect((await tavi(["search", "add", "home", "--kind", "tavily", ...at])).code).toBe(EXIT.usage);
      expect((await tavi(["search", "remove", "nobody", ...at])).code).toBe(EXIT.unavailable);
      expect((await tavi(["search", "test", "nobody", ...at])).code).toBe(EXIT.unavailable);

      // A keyed provider whose key the owner cannot resolve fails its test, as offline.
      expect((await tavi(["search", "add", "brave", "--kind", "brave", "--credential", "brave.apiKey", ...at])).code).toBe(EXIT.ok);
      const unkeyed = await tavi(["search", "test", "brave", ...at]);
      expect(unkeyed.code).toBe(EXIT.taskFailed);
      expect(unkeyed.stderr).toContain("its credential brave.apiKey is not set");

      expect((await tavi(["search", "remove", "home", ...at])).stdout).toBe("removed home\n");
      expect(await handle.runtime.store.asPort().repositories.searchProviders.get("home")).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
  });

  it("prints what offline `tavi search` prints under an owner — JSON, refusals and exits — and no restart note for provider activation", async () => {
    // Before the owner starts: a provider enabled as it composes, so it offers web_search.
    const directory = ownDirectories.create("tavi-search-parity-");
    const at = ["--data-dir", directory];
    let status = 500;
    const instance = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 200 ? JSON.stringify({ results: [] }) : "{}");
    });
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = instance.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      expect((await tavi(["search", "add", "home", "--kind", "searxng", "--base-url", baseUrl, ...at])).code).toBe(EXIT.ok);
      expect((await tavi(["search", "add", "brave", "--kind", "brave", "--credential", "brave.apiKey", ...at])).code).toBe(EXIT.ok);
      // Offline, for comparison.
      const offlineFailed = await tavi(["search", "test", "home", ...at]);
      const offlineUnkeyed = await tavi(["search", "test", "brave", ...at]);
      const offlineJson = JSON.parse((await tavi(["search", "disable", "home", "--format", "json", ...at])).stdout) as Record<
        string,
        unknown
      >;
      await tavi(["search", "enable", "home", ...at]);

      writeFileSync(
        join(directory, "web-providers.json"),
        JSON.stringify({ schemaVersion: 1, workspaces: { default: { search: { providers: ["home", "brave"] } } } }),
      );
      await owners.startOwner(turns([]), { directory });
      const ownerFailed = await tavi(["search", "test", "home", ...at]);
      const ownerUnkeyed = await tavi(["search", "test", "brave", ...at]);
      for (const [owner, offline] of [
        [ownerFailed, offlineFailed],
        [ownerUnkeyed, offlineUnkeyed],
      ] as const) {
        expect(owner.code).toBe(offline.code);
        expect(owner.code).toBe(EXIT.taskFailed);
        expect(owner.stderr).toBe(offline.stderr);
      }
      expect(ownerUnkeyed.stderr).toMatch(/^NOT_CONFIGURED: /);

      // Provider activation takes no restart: no note is printed.
      const disabled = await tavi(["search", "disable", "home", "--format", "json", ...at]);
      expect(JSON.parse(disabled.stdout)).toEqual({ ...offlineJson, updatedAt: expect.any(String) });
      const added = await tavi(["search", "add", "free", "--kind", "tavily", "--format", "json", ...at]);
      expect(JSON.parse(added.stdout)).toMatchObject({ providerId: "free", kind: "tavily", enabled: true });
      expect(added.stderr).not.toContain("restart");
      expect((await tavi(["search", "enable", "home", ...at])).stderr).not.toContain("restart");
      expect(JSON.parse((await tavi(["search", "remove", "free", "--format", "json", ...at])).stdout)).toEqual({ removed: "free" });
      const listed = JSON.parse((await tavi(["search", "list", "--format", "json", ...at])).stdout) as {
        providers: unknown[];
        truncated: boolean;
      };
      expect(listed.providers).toHaveLength(2);
      expect(listed.truncated).toBe(false);
      status = 200;
    } finally {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
  });

  it("adds, shows, disables, enables and removes projects over IPC; import stays offline", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", directory];
    const projects = handle.runtime.store.asPort().repositories.projects;

    const added = await tavi(["projects", "add", "acme", "--name", "Acme", "--keyword", "acme", ...at]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    expect(added.stdout).toBe("acme\tAcme\tenabled\n\n");
    expect((await projects.get("default", "acme"))?.name).toBe("Acme");

    expect((await tavi(["projects", "list", ...at])).stdout).toBe("acme\tAcme\tenabled\tnews keywords\n");
    expect((await tavi(["projects", "show", "acme", ...at])).stdout).toContain("keywords  acme");
    expect((await tavi(["projects", "disable", "acme", ...at])).stdout).toBe("acme\tAcme\tdisabled\n\n");
    expect((await projects.get("default", "acme"))?.enabled).toBe(false);
    expect((await tavi(["projects", "enable", "acme", ...at])).stdout).toBe("acme\tAcme\tenabled\n\n");
    expect((await tavi(["projects", "show", "nothing", ...at])).code).toBe(EXIT.usage);

    const imported = await tavi(["projects", "import", ...at]);
    expect(imported.code).toBe(EXIT.alreadyOwned);
    expect(imported.stderr).toContain("not available on a live owner");

    const removed = await tavi(["projects", "remove", "acme", "--format", "json", ...at]);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: "acme" });
    expect(await projects.get("default", "acme")).toBeUndefined();
  });
});

describe("tavi schedules under a live owner", ATTACHED, () => {
  it("reads, toggles and removes schedules over IPC, and fires one on the owner, following its run", async () => {
    const directory = owners.tempDirectory();
    const seeded = await tavi([
      "schedules",
      "add",
      "--name",
      "nightly",
      "--at",
      "09:00",
      "--timezone",
      "UTC",
      "--prompt",
      "say done",
      "--data-dir",
      directory,
    ]);
    expect(seeded.code, seeded.stderr).toBe(EXIT.ok);
    const { handle } = await owners.startOwner(turns([]), { directory });
    const at = ["--data-dir", directory];

    const listed = await tavi(["schedules", "list", ...at]);
    expect(listed.stdout).toMatch(/\tnightly\tevery day at 09:00 \(UTC\)\tenabled\tnext=\w{3} \d{1,2} \w{3} 09:00\tfailures=0\t/);
    const shown = await tavi(["schedules", "show", "nightly", ...at]);
    expect(shown.stdout).toContain("prompt      say done");
    expect((await tavi(["schedules", "disable", "nightly", ...at])).stdout).toMatch(/\tnightly\tdisabled/);
    expect((await tavi(["schedules", "enable", "nightly", ...at])).stdout).toMatch(/\tnightly\tenabled/);
    expect((await tavi(["schedules", "show", "nobody", ...at])).code).toBe(EXIT.usage);

    for (const [argv, code] of [
      [["--model", "other-model"], EXIT.usage],
      [["--api-key-file", "/nowhere"], EXIT.usage],
    ] as const) {
      expect((await tavi(["schedules", "run-now", "nightly", ...argv, ...at])).code, argv.join(" ")).toBe(code);
    }
    expect(await handle.runtime.store.asPort().repositories.tasks.list(10)).toEqual([]);

    const fired = await tavi(["schedules", "run-now", "nightly", ...at]);
    expect(fired.code, fired.stderr).toBe(EXIT.ok);
    expect(fired.stdout).toContain("done");
    expect((await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.origin).toBe("schedule");

    const added = await tavi(["schedules", "add", "--name", "other", "--at", "10:00", "--timezone", "UTC", "--prompt", "x", ...at]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    // What the offline `add` prints: its cadence after the name, and the notes on what it may call and where a failure goes.
    expect(added.stdout).toMatch(/^sched-\S+\tother\tevery day at 10:00 \(UTC\)\tenabled\tnext=\S/);
    // The allowlist note comes only with an allowlist.
    expect(added.stderr).not.toContain("allowlist");
    expect(added.stderr).toMatch(/other has no alert target, so a failed or missed run is posted to your Home/);
    expect((await tavi(["schedules", "add", "--name", "other", "--at", "10:00", "--timezone", "UTC", "--prompt", "x", ...at])).code).toBe(
      EXIT.usage,
    );
    const wildcard = await tavi([
      "schedules",
      "add",
      "--name",
      "wild",
      "--at",
      "10:00",
      "--timezone",
      "UTC",
      "--prompt",
      "x",
      "--allow",
      "*",
      ...at,
    ]);
    expect(wildcard.code).toBe(EXIT.usage);
    expect(wildcard.stderr).toContain("Name the tools instead");
    const updated = await tavi(["schedules", "update", "other", "--prompt", "changed", "--allow", "web_fetch", ...at]);
    expect(updated.code, updated.stderr).toBe(EXIT.ok);
    expect(updated.stderr).toContain("note: this allowlist governs only the calls that would otherwise need approval");
    expect((await handle.runtime.store.asPort().repositories.schedules.list("default")).find((row) => row.name === "other")?.prompt).toBe(
      "changed",
    );
    expect((await tavi(["schedules", "remove", "other", ...at])).code).toBe(EXIT.ok);

    // As JSON, the fire's stream: the followed run's events, ending on its outcome.
    const streamed = await tavi(["schedules", "run-now", "nightly", "--format", "json", ...at]);
    expect(streamed.code, streamed.stderr).toBe(EXIT.ok);
    const kinds = streamed.stdout
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(kinds.at(-1)).toBe("task.completed");

    expect((await tavi(["schedules", "remove", "nightly", ...at])).code).toBe(EXIT.ok);
    expect(await handle.runtime.store.asPort().repositories.schedules.list("default")).toEqual([]);
  });
});

describe("tavi schedules run-now under a live owner: fires that run nothing", ATTACHED, () => {
  const seed = async (directory: string): Promise<void> => {
    const seeded = await tavi([
      "schedules",
      "add",
      "--name",
      "nightly",
      "--at",
      "09:00",
      "--timezone",
      "UTC",
      "--prompt",
      "say done",
      "--data-dir",
      directory,
    ]);
    expect(seeded.code, seeded.stderr).toBe(EXIT.ok);
  };

  it("reports a fire skipped for overlap (1), and refuses one on an owner with no configured model (2)", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const directory = owners.tempDirectory();
    await seed(directory);
    const { handle } = await owners.startOwner(turns([], held), { directory });
    const at = ["--data-dir", directory];

    const first = tavi(["schedules", "run-now", "nightly", ...at]);
    await waitFor(async () => (await handle.runtime.store.asPort().repositories.tasks.list(10)).length === 1);
    const overlapping = await tavi(["schedules", "run-now", "nightly", ...at]);
    expect(overlapping.code).toBe(EXIT.taskFailed);
    expect(overlapping.stderr).toContain("not run: overlap");
    release();
    expect((await first).code).toBe(EXIT.ok);
    await owners.stopLatest("restart unconfigured");

    await owners.startOwner(turns([]), {
      directory,
      modelTarget: { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" },
    });
    const unconfigured = await tavi(["schedules", "run-now", "nightly", ...at]);
    expect(unconfigured.code).toBe(EXIT.usage);
    expect(unconfigured.stderr).toContain("no configured model");
  });
});
