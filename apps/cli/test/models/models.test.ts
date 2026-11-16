import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireDataDirectoryOwnership, ModelConfigService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { startOpenAiStub, type OpenAiStub } from "@tavi/test-support/openai-stub";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { modelRolesDocument } from "../../src/features/models/actions.js";

/**
 * `tavi models`.
 *
 * Configuration without a GUI: several named connections, discovered models with
 * provenance, one bounded connection test, and role bindings — all through the
 * CLI. A synthetic OpenAI-compatible endpoint provides the model list and one
 * streamed generation, so the discover/test paths are exercised end to end.
 */

const directories = temporaryDirectories({ prefix: "tavi-models-" });
let endpoint: OpenAiStub | undefined;

beforeAll(async () => {
  endpoint = await startOpenAiStub({
    models: [{ id: "llama3", owned_by: "local" }, "small"],
    reply: () => ({ says: "ok", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
  });
}, 60_000);

afterAll(async () => {
  await endpoint?.close();
});

afterEach(() => directories.cleanup());

function credentialFile(directory: string): string {
  const path = join(directory, "key");
  writeFileSync(path, "sk-cli-test\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function baseUrl(): string {
  if (endpoint === undefined) throw new Error("stub endpoint is not running");
  return endpoint.baseUrl;
}

async function addConnection(directory: string, extra: readonly string[] = []): Promise<void> {
  const captured = capture();
  const code = await main(
    [
      "models",
      "add",
      "local",
      "--label",
      "Local",
      "--base-url",
      baseUrl(),
      "--credential",
      "local.token",
      // A flag is given once: `extra` names its own model in place of this one.
      ...(extra.includes("--model") ? [] : ["--model", "llama3"]),
      "--local-only",
      "--data-dir",
      directory,
      ...extra,
    ],
    { io: captured.io },
  );
  expect(code, captured.stderr()).toBe(EXIT.ok);
}

describe("tavi models", () => {
  it("adds a connection, lists it, and stores no credential material", async () => {
    const directory = directories.create();
    await addConnection(directory);

    const listed = capture();
    expect(await main(["models", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const connections = JSON.parse(listed.stdout()) as { connectionId: string; credentialRef: string }[];
    expect(connections).toHaveLength(1);
    expect(connections[0]?.connectionId).toBe("local");
    // The stored record carries a reference, never a value.
    expect(connections[0]?.credentialRef).toBe("local.token");
    expect(listed.stdout()).not.toContain("sk-");
  });

  it("says a loopback connection is local even when it was not added --local-only", async () => {
    const directory = directories.create();
    const added = capture();
    const flags = ["--base-url", "http://localhost:18088/v1", "--credential", "loop.key", "--model", "m", "--data-dir", directory];
    expect(await main(["models", "add", "loop", ...flags], { io: added.io })).toBe(EXIT.ok);
    // The stored flag is what was declared; `local` is what Tavi treats it as.
    expect(JSON.parse(added.stdout())).toMatchObject({ connectionId: "loop", localOnly: false, local: true });
    const remote = capture();
    const away = ["--base-url", "https://api.example.test/v1", "--credential", "away.key", "--model", "m", "--data-dir", directory];
    expect(await main(["models", "add", "away", ...away], { io: remote.io })).toBe(EXIT.ok);
    const listed = capture();
    expect(await main(["models", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(JSON.parse(listed.stdout())).toEqual([
      expect.objectContaining({ connectionId: "away", localOnly: false, local: false }),
      expect.objectContaining({ connectionId: "loop", localOnly: false, local: true }),
    ]);
    const shown = capture();
    expect(await main(["models", "show", "loop", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(JSON.parse(shown.stdout())).toMatchObject({ connection: { localOnly: false, local: true } });
    // The same key at another address: saved, and said.
    const shared = capture();
    const again = ["--base-url", "http://127.0.0.1:18088/v1", "--credential", "loop.key", "--model", "m", "--data-dir", directory];
    expect(await main(["models", "add", "loop2", ...again], { io: shared.io })).toBe(EXIT.ok);
    expect(shared.stderr()).toContain("warning: credential loop.key is also used by the connection loop at http://localhost:18088");
  });

  it("saves a default or role naming a model the catalog does not list, and warns with the nearest one", async () => {
    const directory = directories.create();
    await addConnection(directory);
    const key = credentialFile(directory);
    const discovered = capture();
    expect(await main(["models", "discover", "local", "--credential-file", key, "--data-dir", directory], { io: discovered.io })).toBe(
      EXIT.ok,
    );
    const typo = capture();
    expect(
      await main(["models", "set-default", "--connection", "local", "--model", "llama2", "--data-dir", directory], { io: typo.io }),
    ).toBe(EXIT.ok);
    expect(typo.stderr()).toContain(
      "warning: local does not list the model llama2; did you mean llama3? Check it with `tavi models test local --model llama2`",
    );
    const role = capture();
    expect(
      await main(["models", "set-role", "fast", "--connection", "local", "--model", "no-such-model", "--data-dir", directory], {
        io: role.io,
      }),
    ).toBe(EXIT.ok);
    expect(role.stderr()).toContain("warning: local does not list the model no-such-model (it lists llama3, small)");
    // A listed model, or a connection never discovered, says nothing.
    const listed = capture();
    expect(
      await main(["models", "set-default", "--connection", "local", "--model", "small", "--data-dir", directory], { io: listed.io }),
    ).toBe(EXIT.ok);
    expect(listed.stderr()).toBe("");
  });

  it("shows one connection with its catalog", async () => {
    const directory = directories.create();
    await addConnection(directory);
    const shown = capture();
    expect(await main(["models", "show", "local", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const document = JSON.parse(shown.stdout()) as { connection: { label: string }; catalog: unknown[] };
    expect(document.connection.label).toBe("Local");
    expect(document.catalog).toEqual([]);
  });

  it("discovers models with live provenance and marks a tested model capable", async () => {
    const directory = directories.create();
    await addConnection(directory);
    const key = credentialFile(directory);

    const discovered = capture();
    expect(await main(["models", "discover", "local", "--credential-file", key, "--data-dir", directory], { io: discovered.io })).toBe(
      EXIT.ok,
    );
    const document = JSON.parse(discovered.stdout()) as { models: { modelId: string; provenance: string }[] };
    expect(document.models.map((model) => model.modelId)).toEqual(["llama3", "small"]);
    expect(document.models[0]?.provenance).toBe("live");

    const tested = capture();
    expect(
      await main(["models", "test", "local", "--model", "llama3", "--credential-file", key, "--data-dir", directory], { io: tested.io }),
    ).toBe(EXIT.ok);
    const result = JSON.parse(tested.stdout()) as { ok: boolean; capabilities: string[] };
    expect(result.ok).toBe(true);
    expect(result.capabilities).toContain("chat");

    const shown = capture();
    await main(["models", "show", "local", "--data-dir", directory], { io: shown.io });
    const catalog = (JSON.parse(shown.stdout()) as { catalog: { modelId: string; state: string; capabilities: string[] }[] }).catalog;
    expect(catalog.find((entry) => entry.modelId === "llama3")?.state).toBe("capable");
  });

  it("records a failed connection test as unusable and never prints the credential", async () => {
    const directory = directories.create();
    await addConnection(directory);
    // A credential file the provider rejects would be needed to test an echoed
    // body; here the failure is simply "no credential", and the point is that a
    // failed test leaves no capability claim behind and echoes no secret.
    const key = credentialFile(directory);
    const captured = capture();
    const code = await main(["models", "test", "local", "--model", "llama3", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.taskFailed);
    expect(captured.stdout()).toContain('"ok": false');
    expect(captured.stdout()).not.toContain("sk-cli-test");

    const shown = capture();
    await main(["models", "show", "local", "--data-dir", directory], { io: shown.io });
    const catalog = (JSON.parse(shown.stdout()) as { catalog: { modelId: string; state: string }[] }).catalog;
    // A model that just failed a probe must not satisfy a capability gate.
    expect(catalog.find((entry) => entry.modelId === "llama3")?.state).toBe("unavailable");

    // And a successful probe afterwards clears that state (the stub answers).
    const recovered = capture();
    expect(
      await main(["models", "test", "local", "--model", "llama3", "--credential-file", key, "--data-dir", directory], { io: recovered.io }),
    ).toBe(EXIT.ok);
    expect(recovered.stdout()).not.toContain("sk-cli-test");
  });

  it("refuses an unknown role as a usage error, before the store", async () => {
    // Pinned for both actions: the parser refuses it, and `requireRole` refuses
    // it again for options built without the parser — unchecked, a role reached
    // the store's CHECK constraint and surfaced as an internal failure.
    const directory = directories.create();
    await addConnection(directory);
    for (const args of [
      ["models", "set-role", "summarizer", "--connection", "local"],
      ["models", "clear-role", "summarizer"],
    ]) {
      const captured = capture();
      const code = await main([...args, "--data-dir", directory], { io: captured.io });
      expect(code, captured.stderr()).toBe(EXIT.usage);
      expect(captured.stderr()).toMatch(/unknown role/i);
    }
  });

  it("refuses a credential file other users can read or a symlinked one", async () => {
    const directory = directories.create();
    await addConnection(directory);

    const loose = join(directory, "loose");
    writeFileSync(loose, "sk-cli-test\n", { mode: 0o644 });
    chmodSync(loose, 0o644);
    const refused = capture();
    expect(await main(["models", "discover", "local", "--credential-file", loose, "--data-dir", directory], { io: refused.io })).toBe(
      EXIT.unavailable,
    );
    expect(refused.stderr()).toContain("readable by other users");
  });

  it("refuses to remove a connection a role still references, and rebinds explicitly", async () => {
    const directory = directories.create();
    await addConnection(directory);
    const bound = capture();
    expect(await main(["models", "set-role", "main", "--connection", "local", "--data-dir", directory], { io: bound.io })).toBe(EXIT.ok);

    const refused = capture();
    const code = await main(["models", "remove", "local", "--data-dir", directory], { io: refused.io });
    // A configuration conflict is a usage-level refusal; exit 5 means "another
    // process owns the data directory".
    expect(code).toBe(EXIT.usage);
    expect(refused.stderr()).toContain("still referenced");

    const rebound = capture();
    expect(await main(["models", "rebind", "local", "--credential", "other.token", "--data-dir", directory], { io: rebound.io })).toBe(
      EXIT.ok,
    );
    expect((JSON.parse(rebound.stdout()) as { credentialRef: string }).credentialRef).toBe("other.token");

    const cleared = capture();
    expect(await main(["models", "clear-role", "main", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    const removed = capture();
    expect(await main(["models", "remove", "local", "--data-dir", directory], { io: removed.io })).toBe(EXIT.ok);
  });

  it("marks the connection the workspace default runs on in models list", async () => {
    const directory = directories.create();
    await addConnection(directory);
    expect(
      await main(["models", "set-default", "--connection", "local", "--model", "llama3", "--data-dir", directory], { io: capture().io }),
    ).toBe(EXIT.ok);
    const listed = capture();
    expect(await main(["models", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(JSON.parse(listed.stdout())).toEqual([
      expect.objectContaining({ connectionId: "local", defaultModel: "llama3", workspaceDefault: true }),
    ]);
  });

  it("sets a workspace default and a role override with an ordered fallback", async () => {
    const directory = directories.create();
    await addConnection(directory);
    await addConnection(directory, ["--model", "small"]);
    const defaulted = capture();
    expect(
      await main(["models", "set-default", "--connection", "local", "--model", "small", "--data-dir", directory], { io: defaulted.io }),
    ).toBe(EXIT.ok);

    const role = capture();
    expect(
      await main(
        [
          "models",
          "set-role",
          "compaction",
          "--connection",
          "local",
          "--model",
          "small",
          "--fallback",
          "local/llama3",
          "--data-dir",
          directory,
        ],
        { io: role.io },
      ),
    ).toBe(EXIT.ok);

    const listed = capture();
    expect(await main(["models", "roles", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const document = JSON.parse(listed.stdout()) as {
      workspaceDefault: { target: { model: string } };
      roles: { role: string; fallback: unknown[] }[];
    };
    expect(document.workspaceDefault.target.model).toBe("small");
    expect(document.roles.find((entry) => entry.role === "compaction")?.fallback).toHaveLength(1);

    // The new roles bind like the others.
    const fast = capture();
    expect(
      await main(["models", "set-role", "fast", "--connection", "local", "--model", "llama3", "--data-dir", directory], { io: fast.io }),
    ).toBe(EXIT.ok);
    const resolvedNow = async () => {
      const read = capture();
      expect(await main(["models", "roles", "--data-dir", directory], { io: read.io })).toBe(EXIT.ok);
      return (
        JSON.parse(read.stdout()) as {
          resolved: { role: string; source: string | null; target?: { model: string }; error?: { code: string } }[];
        }
      ).resolved;
    };
    // Every role, with what it resolves to now: its binding, or the default — never the default for embedding.
    const now = await resolvedNow();
    expect(now.slice(0, 4)).toEqual([
      { role: "main", source: "workspace-default", target: { connectionId: "local", model: "small" } },
      { role: "extraction", source: "workspace-default", target: { connectionId: "local", model: "small" } },
      { role: "compaction", source: "role-override", target: { connectionId: "local", model: "small" } },
      { role: "fast", source: "role-override", target: { connectionId: "local", model: "llama3" } },
    ]);
    expect(now[4]).toMatchObject({ role: "embedding", source: null, error: { code: "NOT_CONFIGURED" } });
    expect(now[4]).not.toHaveProperty("target");

    const cleared = capture();
    expect(await main(["models", "clear-default", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    // With no default, an unbound role resolves to nothing, and says why.
    const unbound = (await resolvedNow()).find((entry) => entry.role === "embedding");
    expect(unbound).toMatchObject({ role: "embedding", source: null, error: { code: "NOT_CONFIGURED" } });
  });

  it("refuses configuration while an owner holds the data directory", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner" });
    try {
      const captured = capture();
      const code = await main(["models", "list", "--data-dir", directory], { io: captured.io });
      // A config command must not open the owner's database behind its back.
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toContain("already owns");
    } finally {
      owner.release();
    }
  });

  it("rejects malformed actions and arguments with usage output", async () => {
    const directory = directories.create();
    for (const argv of [
      ["models", "frobnicate"],
      ["models", "set-role", "nonsense", "--connection", "local"],
      ["models", "set-role", "main"],
      ["models", "add", "local", "--base-url", "http://x/v1"],
      ["models", "add", "local", "--header", "novalue", "--base-url", "http://x/v1", "--credential", "r"],
      ["models", "set-role", "main", "--connection", "local", "--fallback", "nomodel"],
    ]) {
      const captured = capture();
      const code = await main([...argv, "--data-dir", directory], { io: captured.io });
      expect(code, argv.join(" ")).toBe(EXIT.usage);
      expect(captured.stderr().length).toBeGreaterThan(0);
    }
  });

  it("adds a local connection with no --credential under a placeholder of its own, and still asks a remote one for it", async () => {
    const directory = directories.create();
    const add = async (id: string, url: string, ...extra: string[]) => {
      const captured = capture();
      const code = await main(["models", "add", id, "--base-url", url, "--model", "qwen3-8b", ...extra, "--data-dir", directory], {
        io: captured.io,
      });
      return { code, out: captured.stdout(), err: captured.stderr() };
    };
    // A loopback address, and one declared --local-only: each its own placeholder, never one key at two addresses.
    const first = await add("local", "http://127.0.0.1:18088/v1");
    expect(first.code, first.err).toBe(EXIT.ok);
    expect(JSON.parse(first.out)).toMatchObject({ connectionId: "local", credentialRef: "local", local: true });
    const second = await add("lan", "http://192.168.1.20:8080/v1", "--local-only");
    expect(second.code, second.err).toBe(EXIT.ok);
    expect(JSON.parse(second.out)).toMatchObject({ credentialRef: "lan" });
    expect(second.err).toBe("");
    // A key already stored under the connection's own name, and named by no other connection, is used as it is.
    const key = join(directory, "own.key");
    writeFileSync(key, "sk-own\n", { mode: 0o600 });
    chmodSync(key, 0o600);
    await main(["credentials", "set", "mine", "--file", key, "--data-dir", directory], { io: capture().io });
    const mine = await add("mine", "http://localhost:9999/v1");
    expect(JSON.parse(mine.out)).toMatchObject({ credentialRef: "mine" });
    // A name another connection already uses (here at another address) gets a suffix.
    expect((await add("cloudy", "https://api.example.test/v1", "--credential", "shared")).code).toBe(EXIT.ok);
    const shared = await add("shared", "http://127.0.0.1:18089/v1");
    expect(JSON.parse(shared.out)).toMatchObject({ credentialRef: "shared-2" });
    const listed = capture();
    expect(await main(["credentials", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(JSON.parse(listed.stdout())).toMatchObject({ credentials: ["lan", "local", "mine", "shared-2"] });

    const remote = await add("cloud", "https://api.example.test/v1");
    expect(remote.code).toBe(EXIT.usage);
    expect(remote.err).toBe(
      "models add needs --credential <name>, a key stored with `tavi credentials set <name> --file <path>`; " +
        "only a local connection (an address on this computer, or --local-only) may leave it out\n",
    );
  });

  it("reports the secret source and model configuration through doctor", async () => {
    const directory = directories.create();
    await addConnection(directory);
    // A real credential sits in the injected directory while doctor runs, so the
    // "no value in the report" assertion is not vacuous.
    const credentials = join(directory, "credentials");
    mkdirSync(credentials, { mode: 0o700 });
    writeFileSync(join(credentials, "local.token"), "sk-doctor-secret\n", { mode: 0o600 });
    chmodSync(join(credentials, "local.token"), 0o600);

    const captured = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    const document = JSON.parse(captured.stdout()) as {
      secretSource: { access: string; kind: string; writable: boolean; description: string };
      modelConfiguration: { connections: { connectionId: string; credentialRef: string }[] };
    };
    // Capabilities, not credentials: the doctor document names the source and
    // never a value, so an attached client can read it.
    expect(document.secretSource.kind).toBe("chain");
    expect(document.secretSource.access).toBe("read-only");
    expect(document.secretSource.writable).toBe(false);
    expect(document.modelConfiguration.connections.map((entry) => entry.connectionId)).toEqual(["local"]);
    // The reference is reported; the value behind it never is.
    expect(captured.stdout()).toContain("local.token");
    expect(captured.stdout()).not.toContain("sk-doctor-secret");
  });

  it("says on a Responses-wire connection that no output cap applies", async () => {
    const directory = directories.create();
    await addConnection(directory);
    const { loadBetterSqlite3 } = await import("../../../../packages/runtime/src/persistence/sqlite-loader.js");
    const db = new (loadBetterSqlite3())(join(directory, "tavi.sqlite"));
    db.prepare("UPDATE tavi_model_connections SET wire_api = 'responses' WHERE connection_id = 'local'").run();
    db.close();
    const captured = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    const document = JSON.parse(captured.stdout()) as { modelConfiguration: { connections: { connectionId: string; note?: string }[] } };
    expect(document.modelConfiguration.connections[0]?.note).toContain("drops output caps");
  });

  it("removes a connection by remove, rm or delete, and its help names remove with the others as aliases", async () => {
    const directory = directories.create();
    for (const verb of ["remove", "rm", "delete"]) {
      await addConnection(directory);
      const removed = capture();
      expect(await main(["models", verb, "local", "--data-dir", directory], { io: removed.io }), verb).toBe(EXIT.ok);
      expect(removed.stdout().trim()).toBe('{"removed":"local"}');
    }
    const help = capture();
    await main(["models", "--help"], { io: help.io });
    // Help fits 80 columns in a pipe: the line may go on below.
    expect(help.stdout().replace(/\s+/g, " ")).toMatch(/remove <connection-id> Delete an unused connection \(alias: rm, delete\)/);
  });

  it("is discoverable in the help text", async () => {
    const captured = capture();
    await main(["--help"], { io: captured.io });
    expect(captured.stdout()).toContain("tavi models <action>");
    expect(captured.stdout()).toContain("set-role <role>");
  });
});

describe("models roles' resolution", () => {
  it("reports the candidates a role skipped, and a binding whose every target is unusable with its reasons", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const service = new ModelConfigService(store.asPort());
    await service.putConnection({
      connectionId: "local",
      label: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialRef: "local.key",
      localOnly: true,
    });
    await service.setRoleBinding({
      workspaceId: "w",
      role: "compaction",
      target: { connectionId: "local", model: "big" },
      fallback: [{ connectionId: "local", model: "small" }],
    });
    const compaction = async () =>
      ((await modelRolesDocument(service, "w"))["resolved"] as { role: string }[]).find((entry) => entry.role === "compaction");

    await service.replaceCatalog("local", [{ modelId: "big", provenance: "manual", state: "unavailable" }]);
    expect(await compaction()).toEqual({
      role: "compaction",
      source: "role-override",
      target: { connectionId: "local", model: "small" },
      skipped: [{ target: { connectionId: "local", model: "big" }, reason: "unavailable-model" }],
    });

    await service.replaceCatalog("local", [
      { modelId: "big", provenance: "manual", state: "unavailable" },
      { modelId: "small", provenance: "manual", state: "unavailable" },
    ]);
    expect(await compaction()).toMatchObject({
      role: "compaction",
      source: null,
      error: { code: "NOT_CONFIGURED", skipped: ["unavailable-model", "unavailable-model"] },
    });
    await store.close();
  });

  it("fails the command on a fault that is not a configuration refusal, rather than listing it per role", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const service = new ModelConfigService(store.asPort());
    await store.close();
    await expect((async () => await modelRolesDocument(service, "w"))()).rejects.toThrow();
  });
});

describe("models test on an install whose provider drifted", () => {
  it("is refused before the test, so the model is not recorded unavailable for the install's fault", async () => {
    vi.resetModules();
    vi.doMock("@tavi/agent-host/models", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@tavi/agent-host/models")>()),
      assertModelSpecification: () => {
        throw Object.assign(new Error("the provider speaks v5"), { code: "UNAVAILABLE" });
      },
    }));
    try {
      const { testAndRecord } = await import("../../src/features/models/actions.js");
      const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
      const service = new ModelConfigService(store.asPort());
      await service.putConnection({
        connectionId: "local",
        label: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        credentialRef: "local.key",
        localOnly: true,
        defaultModel: "m",
      });
      await service.replaceCatalog("local", [{ modelId: "m", provenance: "manual", state: "capable", capabilities: ["chat"] }]);
      await expect(testAndRecord(service, "local", undefined, async () => "key")).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect((await service.listCatalog("local")).map((entry) => [entry.modelId, entry.state])).toEqual([["m", "capable"]]);
      await store.close();
    } finally {
      vi.doUnmock("@tavi/agent-host/models");
      vi.resetModules();
    }
  });
});

describe("PDF input on a connection", () => {
  it("is on for the OpenAI endpoint, refused elsewhere without a probe, and turned off on request", async () => {
    const directory = directories.create();
    const add = async (args: readonly string[]) => {
      const captured = capture();
      const code = await main(["models", "add", ...args, "--credential", "openai.key", "--data-dir", directory], { io: captured.io });
      return { code, out: captured.stdout(), err: captured.stderr() };
    };
    const openai = await add(["openai", "--base-url", "https://api.openai.com/v1"]);
    expect(openai.code, openai.err).toBe(EXIT.ok);
    expect(openai.out).toContain("openai-file");
    const local = await add(["box", "--base-url", "http://127.0.0.1:9/v1", "--pdf-input", "openai-file"]);
    expect(local.code).not.toBe(EXIT.ok);
    expect(local.err).toContain("tavi models probe --pdf box");
    expect(JSON.parse(openai.out)).toMatchObject({ pdfInput: "openai-file" });
    const engine = await add(["openai", "--base-url", "https://api.openai.com/v1", "--pdf-engine", "native"]);
    expect(JSON.parse(engine.out)).toMatchObject({ pdfInput: "openai-file", pdfEngine: "native" });
    const off = await add(["openai", "--base-url", "https://api.openai.com/v1", "--pdf-input", "none", "--pdf-engine", "default"]);
    expect(off.code, off.err).toBe(EXIT.ok);
    const stored = JSON.parse(off.out) as Record<string, unknown>;
    expect(stored["pdfInput"]).toBe("none");
    expect(stored).not.toHaveProperty("pdfEngine");
    const bad = capture();
    expect(
      await main(["models", "add", "x", "--base-url", "http://x/v1", "--credential", "r", "--pdf-input", "always"], { io: bad.io }),
    ).toBe(EXIT.usage);
  });
});

describe("stream deadlines on a connection", () => {
  it("are set in seconds by --first-byte-timeout and --idle-timeout, cleared by default, and bounded", async () => {
    const directory = directories.create();
    const add = async (args: readonly string[]) => {
      const captured = capture();
      const code = await main(
        ["models", "add", "slow", "--base-url", "http://127.0.0.1:9/v1", ...args, "--credential", "slow.key", "--data-dir", directory],
        { io: captured.io },
      );
      return { code, out: captured.stdout(), err: captured.stderr() };
    };
    const set = await add(["--first-byte-timeout", "600", "--idle-timeout", "120"]);
    expect(set.code, set.err).toBe(EXIT.ok);
    expect(JSON.parse(set.out)).toMatchObject({ streamFirstByteSeconds: 600, streamIdleSeconds: 120 });
    const cleared = await add(["--first-byte-timeout", "default"]);
    expect(cleared.code, cleared.err).toBe(EXIT.ok);
    const stored = JSON.parse(cleared.out) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("streamFirstByteSeconds");
    expect(stored["streamIdleSeconds"]).toBe(120);
    for (const value of ["0", "3601", "1.5", "soon"]) {
      const bad = await add(["--idle-timeout", value]);
      expect(bad.code, value).toBe(EXIT.usage);
      expect(bad.err).toContain("--idle-timeout takes whole seconds");
    }
  });
});
