import { ModelConfigService } from "../src/models/config.js";
import { TaviError } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { describe, expect, it } from "vitest";

/**
 * Model configuration and role resolution.
 *
 * These tests pin the properties a task depends on: configuration is stored
 * without credential material, an update never silently discards configuration,
 * a role either resolves to a usable connection or fails with a typed error
 * *before* any provider call, and a corrupt row is reported rather than trusted.
 */

function fixture(options: { readonly now?: () => string } = {}): {
  readonly store: SqliteStore;
  readonly service: ModelConfigService;
} {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const service = new ModelConfigService(store.asPort().repositories.modelConfig, options);
  return { store, service };
}

const connection = {
  connectionId: "local-ollama",
  label: "Local Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialRef: "ollama.token",
  localOnly: true,
} as const;

describe("model connections", () => {
  it("stores the record without credential material and preserves createdAt on update", () => {
    const { store, service } = fixture({ now: () => "2026-01-01T00:00:00.000Z" });
    const created = service.putConnection(connection);
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(created.credentialRef).toBe("ollama.token");

    // The assertion reads the stored row, not the input: a secret that reached
    // the database would be invisible in the fixture otherwise.
    const stored = store.handle.prepare("SELECT * FROM tavi_model_connections WHERE connection_id = ?").get("local-ollama") as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(stored)).not.toMatch(/sk-|Bearer |api[_-]?key/i);

    const later = new ModelConfigService(store.asPort().repositories.modelConfig, {
      now: () => "2026-02-01T00:00:00.000Z",
    });
    const updated = later.putConnection({ ...connection, label: "Renamed" });
    expect(updated.label).toBe("Renamed");
    // The original creation time survives an update rather than being re-stamped.
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    store.close();
  });

  it("gives a new connection its preset's kind, and keeps a saved connection's kind on an update", () => {
    const { store, service } = fixture();
    const anthropic = { connectionId: "claude", label: "Claude", baseUrl: "https://api.anthropic.com/v1", credentialRef: "anthropic.key" };
    expect(service.putConnection(anthropic).kind).toBe("anthropic-messages");
    expect(service.putConnection(connection).kind).toBe("openai-compatible");
    // One saved on the compatibility layer before keeps it until it is added afresh.
    service.putConnection({ ...anthropic, connectionId: "old-claude", kind: "openai-compatible" });
    expect(service.putConnection({ ...anthropic, connectionId: "old-claude", label: "Renamed" }).kind).toBe("openai-compatible");
    // Moved to another endpoint, it speaks what that endpoint's preset does.
    expect(service.putConnection({ ...anthropic, baseUrl: connection.baseUrl, label: "Moved" }).kind).toBe("openai-compatible");
    store.close();
  });

  it("merges an update instead of clearing omitted optional fields", () => {
    const { store, service } = fixture();
    service.putConnection({
      ...connection,
      defaultModel: "llama3",
      headers: { "x-tenant": "acme" },
    });

    // A partial edit carries only what the operator changed; `localOnly`,
    // `defaultModel` and `headers` keep their stored values.
    const updated = service.putConnection({ ...connection, label: "Renamed" });
    expect(updated.defaultModel).toBe("llama3");
    expect(updated.headers).toEqual({ "x-tenant": "acme" });
    expect(updated.localOnly).toBe(true);

    // Clearing is explicit: `null` means "remove this optional value".
    const cleared = service.putConnection({
      ...connection,
      label: "Renamed",
      defaultModel: null,
      headers: null,
      localOnly: false,
    });
    expect(cleared.defaultModel).toBeUndefined();
    expect(cleared.headers).toBeUndefined();
    expect(cleared.localOnly).toBe(false);
    store.close();
  });

  it("rejects an invalid id, a non-http endpoint, embedded credentials and credential-bearing headers", () => {
    const { store, service } = fixture();
    expect(() => service.putConnection({ ...connection, connectionId: "Bad Id" })).toThrowError(TaviError);
    expect(() => service.putConnection({ ...connection, baseUrl: "file:///etc/passwd" })).toThrowError(/http or https/);
    expect(() => service.putConnection({ ...connection, baseUrl: "https://user:secret@example.test/v1" })).toThrowError(
      /must not embed credentials/,
    );
    expect(() =>
      // A credential header would be written to the settings database and echoed
      // by diagnostics; it must come from the secret layer instead.
      service.putConnection({ ...connection, headers: { Authorization: "Bearer sk-live" } }),
    ).toThrowError(/credential header/);
    // The name is not enough: a renamed header carrying a credential value is
    // just as much a secret at rest.
    expect(() => service.putConnection({ ...connection, headers: { "x-custom": "Bearer sk-live-abcdef123456" } })).toThrowError(
      /looks like a credential/,
    );
    expect(() => service.putConnection({ ...connection, headers: { "x-custom": "Basic YWJjZGVmZ2hpamts" } })).toThrowError(
      /looks like a credential/,
    );
    // And the header set is bounded so the row cannot become a blob store.
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-h${index}`, "v"]));
    expect(() => service.putConnection({ ...connection, headers: many })).toThrowError(/at most 16/);
    store.close();
  });

  it("requires an explicit rebinding, and rebinding is the supported operation", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    expect(() => service.putConnection({ ...connection, credentialRef: "other.token" })).toThrowError(/rebindCredential/);

    const rebound = service.rebindCredential({ connectionId: "local-ollama", credentialRef: "other.token" });
    expect(rebound.credentialRef).toBe("other.token");
    // Rebinding keeps everything else about the connection.
    expect(rebound.baseUrl).toBe(connection.baseUrl);
    expect(rebound.localOnly).toBe(true);
    store.close();
  });

  it("withdraws capability claims when the endpoint, credential or headers change", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    const capable = () =>
      service.putCatalogEntry({
        connectionId: "local-ollama",
        modelId: "llama3",
        provenance: "live",
        state: "capable",
        capabilities: ["tools"],
      });
    capable();

    // A cosmetic edit keeps the evidence: renaming does not change what was
    // measured against the endpoint.
    service.putConnection({ ...connection, label: "Renamed" });
    expect(service.listCatalog("local-ollama")[0]?.state).toBe("capable");

    // A transport edit does not: the claim described the previous endpoint.
    service.putConnection({ ...connection, baseUrl: "http://127.0.0.1:11435/v1" });
    const afterEdit = service.listCatalog("local-ollama")[0];
    expect(afterEdit?.state).toBe("available");
    expect(afterEdit?.capabilities).toEqual([]);

    // Rebinding a credential invalidates it too.
    capable();
    service.rebindCredential({ connectionId: "local-ollama", credentialRef: "other.token" });
    expect(service.listCatalog("local-ollama")[0]?.state).toBe("available");
    store.close();
  });

  it("refuses to remove a connection a role, default or catalog entry still names", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.setWorkspaceDefault({ workspaceId: "ws", target: { connectionId: "local-ollama", model: "m" } });
    expect(() => service.removeConnection("local-ollama")).toThrowError(/still used by a model role or a workspace default/);

    service.clearWorkspaceDefault("ws");
    service.removeConnection("local-ollama");
    expect(service.listConnections()).toEqual([]);
    store.close();
  });

  it("removes a connection with the models it discovered, which name nothing else", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putCatalogEntry({ connectionId: "local-ollama", modelId: "gemma4:12b", provenance: "live" });
    service.removeConnection("local-ollama");
    expect(service.listConnections()).toEqual([]);
    // Added again, it starts with no models of the old one's.
    service.putConnection(connection);
    expect(service.listCatalog("local-ollama")).toEqual([]);
    store.close();
  });
});

describe("model catalog", () => {
  it("keeps provenance and state separate, and replaces the catalog atomically", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putCatalogEntry({
      connectionId: "local-ollama",
      modelId: "llama3",
      provenance: "live",
      state: "capable",
      capabilities: ["tools", "streaming"],
      contextWindow: 128_000,
      maxTokens: 4096,
      discoveredAt: "2026-01-01T00:00:00.000Z",
    });
    service.putCatalogEntry({ connectionId: "local-ollama", modelId: "mistral", provenance: "manual" });

    const listed = service.listCatalog("local-ollama");
    expect(listed.map((entry) => entry.modelId)).toEqual(["llama3", "mistral"]);
    expect(listed[0]?.state).toBe("capable");
    // The capacities a listing disclosed come back; an entry without them has none.
    expect(listed[0]).toMatchObject({ contextWindow: 128_000, maxTokens: 4096 });
    expect(listed[1]?.contextWindow).toBeUndefined();
    // `available` is the default: a manual entry is offered, not yet proven.
    expect(listed[1]?.state).toBe("available");

    service.replaceCatalog("local-ollama", [{ modelId: "qwen", provenance: "catalog" }]);
    expect(service.listCatalog("local-ollama").map((entry) => entry.modelId)).toEqual(["qwen"]);
    store.close();
  });

  it("leaves the previous catalog untouched when a replacement is invalid", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putCatalogEntry({ connectionId: "local-ollama", modelId: "keep", provenance: "manual" });

    expect(() =>
      service.replaceCatalog("local-ollama", [
        { modelId: "first", provenance: "catalog" },
        // An empty model id is invalid; validation happens before any write, or
        // the catalog would end up as a merge of old and new.
        { modelId: "", provenance: "catalog" },
      ]),
    ).toThrowError(/Invalid catalog entry at index 1/);
    expect(service.listCatalog("local-ollama").map((entry) => entry.modelId)).toEqual(["keep"]);
    store.close();
  });

  it("refuses a catalog entry for a connection that does not exist", () => {
    const { store, service } = fixture();
    expect(() => service.putCatalogEntry({ connectionId: "absent", modelId: "m", provenance: "manual" })).toThrowError(
      /No model connection/,
    );
    expect(() => service.replaceCatalog("absent", [{ modelId: "m", provenance: "manual" }])).toThrowError(/No model connection/);
    store.close();
  });

  it("rejects a stored row the current schema does not accept", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    // Simulate a database written by an older or edited release: the read path
    // must report a typed failure rather than casting the value into the runtime.
    store.handle
      .prepare(
        `INSERT INTO tavi_model_catalog (connection_id, model_id, provenance, state, capabilities_json)
         VALUES ('local-ollama', 'broken', 'manual', 'available', 'not json')`,
      )
      .run();
    expect(() => service.listCatalog("local-ollama")).toThrowError(/not valid JSON/);
    store.close();
  });

  it("refuses a stored value the migration's CHECK constraint forbids", () => {
    const { store } = fixture();
    // The schema is the first guard; this proves the database is a second one.
    expect(() =>
      store.handle
        .prepare(
          `INSERT INTO tavi_model_catalog (connection_id, model_id, provenance, state, capabilities_json)
           VALUES ('c', 'm', 'guessed', 'available', '[]')`,
        )
        .run(),
    ).toThrowError(/CHECK|constraint/i);
    store.close();
  });
});

describe("role resolution", () => {
  it("prefers a role override, then the workspace default, and refuses when neither is set", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putConnection({
      ...connection,
      connectionId: "cloud",
      baseUrl: "https://api.example.test/v1",
      localOnly: false,
    });

    expect(() => service.resolveRole({ workspaceId: "ws", role: "main" })).toThrowError(/No model is configured for role main/);

    service.setWorkspaceDefault({ workspaceId: "ws", target: { connectionId: "cloud", model: "gpt" } });
    const byDefault = service.resolveRole({ workspaceId: "ws", role: "main" });
    expect(byDefault.target).toEqual({ connectionId: "cloud", model: "gpt" });
    expect(byDefault.source).toBe("workspace-default");
    expect(byDefault.localOnly).toBe(false);
    // The resolution carries the connection, so a dispatcher needs no second
    // lookup to reach the endpoint.
    expect(byDefault.connection.baseUrl).toBe("https://api.example.test/v1");

    service.setRoleBinding({
      workspaceId: "ws",
      role: "main",
      target: { connectionId: "local-ollama", model: "llama3" },
      fallback: [{ connectionId: "cloud", model: "gpt" }],
    });
    const byOverride = service.resolveRole({ workspaceId: "ws", role: "main" });
    expect(byOverride.target).toEqual({ connectionId: "local-ollama", model: "llama3" });
    expect(byOverride.source).toBe("role-override");
    expect(byOverride.fallback).toEqual([{ connectionId: "cloud", model: "gpt" }]);
    expect(byOverride.localOnly).toBe(true);
    store.close();
  });

  it("binds and resolves the fast and embedding roles, and only embedding never falls back to the default", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.setWorkspaceDefault({ workspaceId: "w1", target: { connectionId: connection.connectionId, model: "llama3" } });
    service.setRoleBinding({ workspaceId: "w1", role: "fast", target: { connectionId: connection.connectionId, model: "llama3:8b" } });
    service.setRoleBinding({
      workspaceId: "w1",
      role: "embedding",
      target: { connectionId: connection.connectionId, model: "nomic-embed-text" },
    });
    expect(service.resolveRole({ workspaceId: "w1", role: "fast" })).toMatchObject({
      source: "role-override",
      target: { model: "llama3:8b" },
    });
    expect(service.resolveRole({ workspaceId: "w1", role: "embedding" })).toMatchObject({
      source: "role-override",
      target: { model: "nomic-embed-text" },
    });
    service.clearRoleBinding("w1", "fast");
    // Unbound, a role runs on the workspace default, as the five always have.
    expect(service.resolveRole({ workspaceId: "w1", role: "fast" })).toMatchObject({
      source: "workspace-default",
      target: { model: "llama3" },
    });
    // Embedding never runs on the workspace default: only its own binding counts.
    service.clearRoleBinding("w1", "embedding");
    expect(() => service.resolveRole({ workspaceId: "w1", role: "embedding" })).toThrowError(
      /No embedding model is bound in workspace w1\. Bind one with `tavi models set-role embedding/,
    );
    expect(() => service.resolveRole({ workspaceId: "w1", role: "thinking" as never })).toThrowError(/Unknown model role/);
    store.close();
  });

  it("uses the connection default model when a target omits one", () => {
    const { store, service } = fixture();
    service.putConnection({ ...connection, defaultModel: "llama3" });
    service.setWorkspaceDefault({ workspaceId: "ws", target: { connectionId: "local-ollama" } });
    expect(service.getWorkspaceDefault("ws")?.target).toEqual({ connectionId: "local-ollama", model: "llama3" });

    // A connection with no default cannot satisfy a target that omits the model.
    service.clearWorkspaceDefault("ws");
    service.putConnection({ ...connection, defaultModel: null });
    expect(() => service.setWorkspaceDefault({ workspaceId: "ws", target: { connectionId: "local-ollama" } })).toThrowError(
      /no default model/,
    );
    store.close();
  });

  it("skips a model the catalog marks unavailable and reports why", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putCatalogEntry({
      connectionId: "local-ollama",
      modelId: "broken",
      provenance: "live",
      state: "unavailable",
    });
    service.putCatalogEntry({
      connectionId: "local-ollama",
      modelId: "working",
      provenance: "live",
      state: "capable",
    });
    service.setRoleBinding({
      workspaceId: "ws",
      role: "main",
      target: { connectionId: "local-ollama", model: "broken" },
      fallback: [{ connectionId: "local-ollama", model: "working" }],
    });

    const resolution = service.resolveRole({ workspaceId: "ws", role: "main" });
    expect(resolution.target.model).toBe("working");
    expect(resolution.skipped).toEqual([{ target: { connectionId: "local-ollama", model: "broken" }, reason: "unavailable-model" }]);
    store.close();
  });

  it("enforces required capabilities and reports a typed capability failure", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.putCatalogEntry({
      connectionId: "local-ollama",
      modelId: "plain",
      provenance: "live",
      state: "capable",
      capabilities: ["streaming"],
    });
    service.setWorkspaceDefault({ workspaceId: "ws", target: { connectionId: "local-ollama", model: "plain" } });

    expect(() => service.resolveRole({ workspaceId: "ws", role: "main", requireCapabilities: ["tools"] })).toThrowError(
      /declares the required capabilities/,
    );

    service.putCatalogEntry({
      connectionId: "local-ollama",
      modelId: "plain",
      provenance: "live",
      state: "capable",
      capabilities: ["streaming", "tools"],
    });
    const resolution = service.resolveRole({
      workspaceId: "ws",
      role: "main",
      requireCapabilities: ["tools"],
    });
    expect(resolution.target.model).toBe("plain");
    store.close();
  });

  it("falls through the explicit chain and reports what it skipped", () => {
    const { store, service } = fixture();
    service.putConnection({ ...connection, connectionId: "secondary", baseUrl: "https://api.example.test/v1" });
    // The API refuses an unknown target when a binding is written (asserted
    // below). A dangling row can still exist — a restored backup, or a database
    // edited by an older release — so it is written through the repository to
    // prove resolution reports it instead of throwing or silently substituting.
    store.asPort().repositories.modelConfig.setRoleBinding({
      workspaceId: "ws",
      role: "compaction",
      target: { connectionId: "gone", model: "m" },
      fallback: [{ connectionId: "secondary", model: "small" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const resolution = service.resolveRole({ workspaceId: "ws", role: "compaction" });
    expect(resolution.target).toEqual({ connectionId: "secondary", model: "small" });
    expect(resolution.skipped).toEqual([{ target: { connectionId: "gone", model: "m" }, reason: "missing-connection" }]);
    store.close();
  });

  it("refuses a chain whose every target is missing, and rejects duplicate or oversized chains", () => {
    const { store, service } = fixture();
    // Writing an unknown target is refused immediately, before any task can fail
    // on it (typed errors before dispatch).
    expect(() =>
      service.setRoleBinding({
        workspaceId: "ws",
        role: "main",
        target: { connectionId: "gone", model: "m" },
      }),
    ).toThrowError(/No model connection/);

    store.asPort().repositories.modelConfig.setRoleBinding({
      workspaceId: "ws",
      role: "main",
      target: { connectionId: "gone", model: "m" },
      fallback: [{ connectionId: "also-gone", model: "m" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => service.resolveRole({ workspaceId: "ws", role: "main" })).toThrowError(
      /Every configured target for role main is unusable/,
    );

    service.putConnection(connection);
    expect(() =>
      service.setRoleBinding({
        workspaceId: "ws",
        role: "main",
        target: { connectionId: "local-ollama", model: "llama3" },
        fallback: [{ connectionId: "local-ollama", model: "llama3" }],
      }),
    ).toThrowError(/Duplicate target/);
    expect(() =>
      service.setRoleBinding({
        workspaceId: "ws",
        role: "main",
        target: { connectionId: "local-ollama", model: "llama3" },
        fallback: [
          { connectionId: "a", model: "1" },
          { connectionId: "b", model: "2" },
          { connectionId: "c", model: "3" },
          { connectionId: "d", model: "4" },
        ],
      }),
    ).toThrowError(/At most three/);
    store.close();
  });

  it("scopes role bindings and defaults to their workspace", () => {
    const { store, service } = fixture();
    service.putConnection(connection);
    service.setWorkspaceDefault({ workspaceId: "ws-a", target: { connectionId: "local-ollama", model: "a" } });
    // A default is workspace data: another workspace must not inherit it by
    // falling back to a global row.
    expect(() => service.resolveRole({ workspaceId: "ws-b", role: "main" })).toThrowError(/No model is configured/);
    expect(service.listRoleBindings("ws-b")).toEqual([]);
    store.close();
  });
});

describe("provider-managed model connections", () => {
  it("round-trips ownership, refuses ordinary edits, and scopes role bindings", () => {
    const { store, service } = fixture();
    try {
      const ordinary = service.putConnection({ ...connection, defaultModel: "m" });
      const managed = {
        ...ordinary,
        providerBinding: { instanceId: ordinary.connectionId, workspaceId: "a", principalId: "owner-a", bindingHash: "a".repeat(64) },
      };
      store.asPort().repositories.modelConfig.upsertConnection(managed);
      expect(service.getConnection(ordinary.connectionId)).toEqual(managed);
      expect(() => service.putConnection(connection)).toThrow(/plugin instance/);
      expect(() => service.rebindCredential({ connectionId: ordinary.connectionId, credentialRef: "other.key" })).toThrow(
        /plugin instance/,
      );
      expect(() => service.removeConnection(ordinary.connectionId)).toThrow(/plugin instance/);
      expect(() => service.setWorkspaceDefault({ workspaceId: "b", target: { connectionId: ordinary.connectionId } })).toThrow(
        /another workspace/,
      );
      service.setWorkspaceDefault({ workspaceId: "a", target: { connectionId: ordinary.connectionId } });
      expect(service.resolveRole({ workspaceId: "a", role: "main" }).connection).toEqual(managed);
    } finally {
      store.close();
    }
  });
});

describe("PDF input per connection", () => {
  const openai = {
    connectionId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "openai.key",
    localOnly: false,
  } as const;
  const anthropic = {
    connectionId: "claude",
    label: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    credentialRef: "anthropic.key",
    localOnly: false,
  } as const;

  it("is on for the presets that take PDFs, off elsewhere, and kept across a restart", () => {
    const { store, service } = fixture();
    expect(service.putConnection(openai).pdfInput).toBe("openai-file");
    expect(service.putConnection({ ...openai, connectionId: "router", baseUrl: "https://openrouter.ai/api/v1/" }).pdfInput).toBe(
      "openai-file",
    );
    expect(service.putConnection(connection).pdfInput).toBe("none");
    expect(service.putConnection(anthropic).pdfInput).toBe("none");
    expect(new ModelConfigService(store.asPort().repositories.modelConfig).getConnection("openai").pdfInput).toBe("openai-file");
  });

  it("is turned on elsewhere only by a passed probe, never for an endpoint that drops files, and off when the endpoint moves", () => {
    const { service } = fixture();
    service.putConnection(connection);
    expect(() => service.putConnection({ ...connection, pdfInput: "openai-file" })).toThrow(/tavi models probe --pdf local-ollama/);
    expect(service.confirmPdfInput({ connectionId: "local-ollama" }).pdfInput).toBe("openai-file");
    // An edit that keeps the endpoint keeps it; moving the endpoint drops it.
    expect(service.putConnection({ ...connection, label: "Renamed" }).pdfInput).toBe("openai-file");
    expect(service.putConnection({ ...connection, baseUrl: "http://127.0.0.1:8080/v1" }).pdfInput).toBe("none");
    service.putConnection(anthropic);
    expect(() => service.confirmPdfInput({ connectionId: "claude" })).toThrow(TaviError);
  });

  it("keeps OpenRouter's file-parser engine, and turns PDF input off on request", () => {
    const { service } = fixture();
    const router = { ...openai, connectionId: "router", baseUrl: "https://openrouter.ai/api/v1" };
    expect(service.putConnection({ ...router, pdfEngine: "mistral-ocr" })).toMatchObject({
      pdfInput: "openai-file",
      pdfEngine: "mistral-ocr",
    });
    expect(service.putConnection({ ...router, label: "Router" }).pdfEngine).toBe("mistral-ocr");
    expect(service.putConnection({ ...router, pdfInput: "none", pdfEngine: null })).toMatchObject({ pdfInput: "none" });
    // Off stays off across an edit, though the preset would take PDFs.
    expect(service.putConnection({ ...router, label: "Router" }).pdfInput).toBe("none");
  });

  it("reads back across a restart: the engine, a confirmed probe, and a row with no stored PDF input as its preset's", () => {
    const { store, service } = fixture();
    service.putConnection({ ...openai, connectionId: "router", baseUrl: "https://openrouter.ai/api/v1", pdfEngine: "native" });
    service.putConnection(connection);
    service.confirmPdfInput({ connectionId: "local-ollama" });
    service.putConnection(openai);
    store.handle.prepare("UPDATE tavi_model_connections SET pdf_input = NULL WHERE connection_id = 'openai'").run();
    const later = new ModelConfigService(store.asPort().repositories.modelConfig);
    expect(later.getConnection("router")).toMatchObject({ pdfInput: "openai-file", pdfEngine: "native" });
    expect(later.getConnection("local-ollama").pdfInput).toBe("openai-file");
    expect(later.getConnection("openai").pdfInput).toBe("openai-file");
  });

  it("compares endpoints as endpoints: a trailing slash or a host's case is the same one", () => {
    const { service } = fixture();
    service.putConnection(connection);
    service.confirmPdfInput({ connectionId: "local-ollama" });
    expect(service.putConnection({ ...connection, baseUrl: `${connection.baseUrl}/` }).pdfInput).toBe("openai-file");
    service.putConnection({ ...anthropic, baseUrl: "https://API.Anthropic.com/v1/" });
    expect(() => service.confirmPdfInput({ connectionId: "claude" })).toThrow(/drops PDF file parts/);
    // The engine is the endpoint's: it goes when the endpoint moves.
    service.putConnection({ ...openai, connectionId: "router", baseUrl: "https://openrouter.ai/api/v1", pdfEngine: "native" });
    expect(service.putConnection({ ...openai, connectionId: "router", baseUrl: "https://api.openai.com/v1" }).pdfEngine).toBeUndefined();
  });
});

describe("stream deadlines per connection", () => {
  it("are kept across an edit and a restart, cleared by null, dropped when the endpoint moves, and bounded", () => {
    const { store, service } = fixture();
    expect(service.putConnection({ ...connection, streamFirstByteSeconds: 300, streamIdleSeconds: 120 })).toMatchObject({
      streamFirstByteSeconds: 300,
      streamIdleSeconds: 120,
    });
    expect(service.putConnection({ ...connection, label: "Renamed" })).toMatchObject({
      streamFirstByteSeconds: 300,
      streamIdleSeconds: 120,
    });
    const later = new ModelConfigService(store.asPort().repositories.modelConfig);
    expect(later.getConnection("local-ollama")).toMatchObject({ streamFirstByteSeconds: 300, streamIdleSeconds: 120 });
    const cleared = service.putConnection({ ...connection, streamFirstByteSeconds: null });
    expect(cleared.streamFirstByteSeconds).toBeUndefined();
    expect(cleared.streamIdleSeconds).toBe(120);
    expect(service.putConnection({ ...connection, baseUrl: "http://127.0.0.1:8080/v1" }).streamIdleSeconds).toBeUndefined();
    expect(() => service.putConnection({ ...connection, streamIdleSeconds: 0 })).toThrow(TaviError);
    expect(() => service.putConnection({ ...connection, streamIdleSeconds: 3601 })).toThrow(TaviError);
  });
});

describe("native video per model", () => {
  const router = {
    connectionId: "router",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "openrouter.key",
    localOnly: false,
  } as const;
  const vllm = {
    connectionId: "vllm",
    label: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    credentialRef: "vllm.key",
    localOnly: true,
  } as const;
  const catalog = (service: ModelConfigService, connectionId: string, modelId: string, capabilities: string[]): void => {
    service.putCatalogEntry({ connectionId, modelId, provenance: "live", state: "available", capabilities });
  };

  it("turns on for a model its catalog or a probe says reads video, only with the disclosure confirmed, and keeps it across a restart", () => {
    const { store, service } = fixture();
    service.putConnection(router);
    catalog(service, "router", "qwen/qwen3-vl", ["video"]);
    catalog(service, "router", "plain/model", ["chat"]);
    expect(() => service.setVideoModel({ connectionId: "router", modelId: "qwen/qwen3-vl", enabled: true })).toThrow(
      /sends the whole clip/,
    );
    expect(() =>
      service.setVideoModel({ connectionId: "router", modelId: "plain/model", enabled: true, disclosureConfirmed: true }),
    ).toThrow(/not known to read video/);
    expect(() => service.setVideoModel({ connectionId: "router", modelId: "unlisted", enabled: true, disclosureConfirmed: true })).toThrow(
      /not known to read video/,
    );
    expect(
      service.setVideoModel({ connectionId: "router", modelId: "qwen/qwen3-vl", enabled: true, disclosureConfirmed: true }).videoModels,
    ).toEqual(["qwen/qwen3-vl"]);
    // A probe's token qualifies a model too, on any endpoint that ever takes video.
    service.putConnection(vllm);
    catalog(service, "vllm", "Qwen3-VL-8B", ["chat", "video-probed"]);
    expect(
      service.setVideoModel({ connectionId: "vllm", modelId: "Qwen3-VL-8B", enabled: true, disclosureConfirmed: true }).videoModels,
    ).toEqual(["Qwen3-VL-8B"]);
    const later = new ModelConfigService(store.asPort().repositories.modelConfig);
    expect(later.getConnection("router").videoModels).toEqual(["qwen/qwen3-vl"]);
    expect(later.setVideoModel({ connectionId: "router", modelId: "qwen/qwen3-vl", enabled: false }).videoModels).toBeUndefined();
  });

  it("never turns on where the endpoint takes none: Anthropic's and OpenAI's presets", () => {
    const { service } = fixture();
    for (const preset of [
      {
        connectionId: "claude",
        label: "Claude",
        baseUrl: "https://api.anthropic.com/v1",
        credentialRef: "anthropic.key",
        localOnly: false,
      },
      { connectionId: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialRef: "openai.key", localOnly: false },
    ] as const) {
      service.putConnection(preset);
      catalog(service, preset.connectionId, "some-model", ["video"]);
      expect(() =>
        service.setVideoModel({ connectionId: preset.connectionId, modelId: "some-model", enabled: true, disclosureConfirmed: true }),
      ).toThrow(/takes no video/);
    }
  });

  it("keeps the models and their tokens across a transport change on the same endpoint, and drops both when it moves", () => {
    const { service } = fixture();
    service.putConnection(vllm);
    catalog(service, "vllm", "Qwen3-VL-8B", ["chat", "tools", "video-probed"]);
    service.setVideoModel({ connectionId: "vllm", modelId: "Qwen3-VL-8B", enabled: true, disclosureConfirmed: true });
    expect(service.putConnection({ ...vllm, label: "Renamed" }).videoModels).toEqual(["Qwen3-VL-8B"]);
    // A new default model and a new credential withdraw what a test saw, never what the model is.
    service.putConnection({ ...vllm, defaultModel: "other" });
    service.rebindCredential({ connectionId: "vllm", credentialRef: "vllm.other" });
    expect(service.listCatalog("vllm").find((entry) => entry.modelId === "Qwen3-VL-8B")?.capabilities).toEqual(["video-probed"]);
    expect(service.getConnection("vllm").videoModels).toEqual(["Qwen3-VL-8B"]);
    expect(
      service.putConnection({ ...vllm, credentialRef: "vllm.other", baseUrl: "http://127.0.0.1:9000/v1" }).videoModels,
    ).toBeUndefined();
    expect(service.listCatalog("vllm").find((entry) => entry.modelId === "Qwen3-VL-8B")?.capabilities).toEqual([]);
  });
});
