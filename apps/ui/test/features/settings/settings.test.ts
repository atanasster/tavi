import type { ClientResponse } from "@tavi/client/browser";
import { describe, expect, it } from "vitest";

import {
  browse,
  loadModels,
  chosenTarget,
  loadChatModel,
  modelPickNote,
  planModelPick,
  loadTarget,
  modelActions,
  targetNotice,
  type OwnerTarget,
  rolesOf,
  type BrowsedModel,
  type RolesDocument,
} from "../../../src/features/settings/models-api.js";
import {
  saveWebSearchProvider,
  keyToStore,
  searchActions,
  searchKindNeeds,
  validateWebSearchForm,
} from "../../../src/features/settings/search-api.js";
import { credentialActions, validateCredentialForm } from "../../../src/features/settings/credentials-api.js";
import {
  systemPromptActions,
  systemPromptDirty,
  systemPromptProblem,
  systemPromptState,
} from "../../../src/features/settings/system-prompt-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { freeId } from "../../../src/features/settings/WebSearchFormModal.js";

/**
 * The canvas's settings: the reads and writes the ported
 * views make, over the IPC families `tavi models|search|credentials` use.
 */

function client(answer: (command: string, payload: Record<string, unknown>) => ClientResponse) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const fake: SettingsClient = {
    request: (command, payload) => {
      sent.push({ command, payload: payload as Record<string, unknown> });
      return Promise.resolve(answer(command, payload as Record<string, unknown>));
    },
  };
  return { fake, sent };
}

/**
 * An owner answering what a save asks: its providers, credentials and
 * connections as given, and `add`/`set` accepted unless refused.
 */
function owner(state: {
  readonly providers?: { readonly providers: readonly { readonly providerId: string }[]; readonly unreadable?: readonly string[] };
  readonly credentials?: readonly string[];
  readonly connections?: readonly { readonly credentialRef: string }[];
  readonly added?: unknown;
  readonly addRefused?: string;
  readonly setRefused?: string;
}) {
  return (command: string, payload: Record<string, unknown>): ClientResponse => {
    const action = payload["action"];
    if (command === "search" && action === "list") return { ok: true, result: state.providers ?? { providers: [] } };
    if (command === "credentials" && action === "list") return { ok: true, result: { credentials: state.credentials ?? [], unusable: [] } };
    if (command === "models" && action === "list") return { ok: true, result: state.connections ?? [] };
    if (command === "credentials" && action === "set") {
      return state.setRefused === undefined
        ? { ok: true, result: {} }
        : { ok: false, error: { code: "NOT_AUTHORIZED", message: state.setRefused } };
    }
    if (command === "search" && action === "add") {
      return state.addRefused === undefined
        ? { ok: true, result: state.added ?? { result: {}, restartRequired: false } }
        : { ok: false, error: { code: "CONFLICT", message: state.addRefused } };
    }
    return { ok: true, result: {} };
  };
}

const model = (fields: Partial<BrowsedModel> & Pick<BrowsedModel, "modelId">): BrowsedModel => ({
  connectionId: "openai",
  connectionLabel: "OpenAI",
  provenance: "live",
  state: "available",
  capabilities: [],
  stale: false,
  ...fields,
});

describe("the model browser's data", () => {
  it("loads the connections, each catalog and the roles, and says why when the owner refuses", async () => {
    const { fake, sent } = client((_command, payload) => {
      if (payload["action"] === "list")
        return {
          ok: true,
          result: [
            {
              connectionId: "openai",
              label: "OpenAI",
              kind: "openai-compatible",
              baseUrl: "https://x",
              credentialRef: "openai.apiKey",
              localOnly: false,
              defaultModel: null,
            },
          ],
        };
      if (payload["action"] === "roles") return { ok: true, result: { workspaceDefault: null, roles: [], resolved: [] } };
      return {
        ok: true,
        result: {
          connection: {},
          catalog: [
            { connectionId: "openai", modelId: "gpt-5", provenance: "live", state: "capable", capabilities: ["tools"], stale: true },
          ],
        },
      };
    });
    const loaded = await loadModels(fake, "default");
    expect(sent.map((request) => request.payload["action"])).toEqual(["list", "roles", "show"]);
    expect(loaded).toMatchObject({ ok: true, value: { models: [{ modelId: "gpt-5", connectionLabel: "OpenAI", stale: true }] } });

    const refused = client(() => ({ ok: false, error: { code: "NOT_AUTHORIZED", message: "not allowed" } }));
    // The owner's typed code travels with the words, so a caller can branch on
    // `CONFLICT` without scraping the message.
    expect(await loadModels(refused.fake, "default")).toEqual({ ok: false, message: "not allowed", code: "NOT_AUTHORIZED" });
  });

  it("merges several connections' catalogs, and reports one it cannot read beside the others", async () => {
    const connection = (connectionId: string) => ({
      connectionId,
      label: connectionId.toUpperCase(),
      kind: "openai-compatible",
      baseUrl: "https://x",
      credentialRef: `${connectionId}.apiKey`,
      localOnly: false,
      defaultModel: null,
    });
    const { fake } = client((_command, payload) => {
      if (payload["action"] === "list") return { ok: true, result: [connection("a"), connection("b"), connection("gone")] };
      if (payload["action"] === "roles") return { ok: true, result: { workspaceDefault: null, roles: [], resolved: [] } };
      if (payload["connectionId"] === "gone") return { ok: false, error: { code: "NOT_FOUND", message: "no connection gone" } };
      return {
        ok: true,
        result: {
          catalog: [
            {
              connectionId: payload["connectionId"],
              modelId: `${String(payload["connectionId"])}-model`,
              provenance: "live",
              state: "available",
              capabilities: [],
            },
          ],
        },
      };
    });
    const loaded = await loadModels(fake, "default");
    expect(loaded.ok && loaded.value.models.map((entry) => `${entry.connectionLabel}:${entry.modelId}`)).toEqual([
      "A:a-model",
      "B:b-model",
    ]);
    expect(loaded.ok && loaded.value.failures).toEqual([{ connectionId: "gone", message: "no connection gone" }]);
  });

  it("filters by search, connection, state and tool calling, and sorts best first", () => {
    const models = [
      model({ modelId: "b-small", state: "available" }),
      model({ modelId: "a-large", state: "capable", capabilities: ["tools"] }),
      model({ modelId: "c-local", state: "unavailable", connectionId: "ollama", connectionLabel: "Ollama" }),
    ];
    const all = { search: "", connectionId: "", state: "", toolsOnly: false };
    expect(browse(models, all, "state").map((entry) => entry.modelId)).toEqual(["a-large", "b-small", "c-local"]);
    expect(browse(models, all, "connection").map((entry) => entry.modelId)).toEqual(["c-local", "a-large", "b-small"]);
    expect(browse(models, { ...all, search: "LOCAL" }, "name").map((entry) => entry.modelId)).toEqual(["c-local"]);
    expect(browse(models, { ...all, search: "ollama" }, "name").map((entry) => entry.modelId)).toEqual(["c-local"]);
    expect(browse(models, { ...all, connectionId: "openai", state: "available" }, "name").map((entry) => entry.modelId)).toEqual([
      "b-small",
    ]);
    expect(browse(models, { ...all, toolsOnly: true }, "name").map((entry) => entry.modelId)).toEqual(["a-large"]);
  });

  it("names the roles a model serves, and notes a write the owner applies after a restart", async () => {
    const roles: RolesDocument = {
      workspaceDefault: { target: { connectionId: "openai", model: "gpt-5" } },
      resolved: [
        { role: "main", source: "workspace-default", target: { connectionId: "openai", model: "gpt-5" } },
        { role: "fast", source: "role-override", target: { connectionId: "openai", model: "gpt-5-mini" } },
        { role: "embedding", source: null, error: { code: "NOT_CONFIGURED", message: "none" } },
      ],
    };
    expect(rolesOf({ connectionId: "openai", modelId: "gpt-5" }, roles)).toEqual(["main"]);
    // The same model id on another connection serves nothing.
    expect(rolesOf({ connectionId: "azure", modelId: "gpt-5" }, roles)).toEqual([]);
    const { fake, sent } = client(() => ({ ok: true, result: { result: {}, restartRequired: true } }));
    expect(await modelActions.setDefault(fake, "default", "openai", "gpt-5")).toMatchObject({
      ok: true,
      value: expect.stringContaining("restart"),
    });
    expect(await modelActions.setRole(fake, "default", "fast", "openai", "gpt-5-mini")).toMatchObject({ ok: true });
    const tested = client(() => ({ ok: true, result: { ok: false, message: "the model refused tools" } }));
    expect(await modelActions.test(tested.fake, "openai", "gpt-5")).toEqual({
      ok: false,
      message: "gpt-5 failed its test: the model refused tools",
    });
    const passed = client(() => ({ ok: true, result: { ok: true, latencyMs: 120 } }));
    expect(await modelActions.test(passed.fake, "openai", "gpt-5")).toEqual({ ok: true, value: "gpt-5 answered its test in 120 ms." });
    expect(sent.map((request) => request.payload)).toEqual([
      { action: "set-default", workspaceId: "default", connectionId: "openai", model: "gpt-5" },
      { action: "set-role", workspaceId: "default", role: "fast", connectionId: "openai", model: "gpt-5-mini" },
    ]);
  });
});

describe("the workspace's target, as the footer strip names it", () => {
  /** An owner whose `models roles` answers `document`. */
  const answering = (document: unknown) =>
    client((command, payload) =>
      command === "models" && payload["action"] === "roles"
        ? { ok: true, result: document }
        : { ok: false, error: { code: "FAILED", message: "unexpected" } },
    );

  it("names the connection and the model the workspace's default resolves to", async () => {
    const { fake, sent } = answering({ workspaceDefault: { target: { connectionId: "openrouter", model: "gpt-5" } }, resolved: [] });
    expect(await loadTarget(fake, "default")).toEqual({
      ok: true,
      value: { running: "openrouter/gpt-5", unconfigured: false, afterRestart: undefined, restartRequired: false },
    });
    expect(sent).toEqual([{ command: "models", payload: { action: "roles", workspaceId: "default" } }]);
  });

  it("names the connection alone when the default binds no model", async () => {
    const { fake } = answering({ workspaceDefault: { target: { connectionId: "ollama" } }, resolved: [] });
    expect(await loadTarget(fake, "default")).toEqual({
      ok: true,
      value: { running: "ollama", unconfigured: false, afterRestart: undefined, restartRequired: false },
    });
  });

  it("answers nothing for a workspace with no default, rather than inventing one", async () => {
    const { fake } = answering({ workspaceDefault: null, resolved: [] });
    expect(await loadTarget(fake, "default")).toEqual({
      ok: true,
      value: { running: undefined, unconfigured: false, afterRestart: undefined, restartRequired: false },
    });
  });

  it("says a refusal in words, so the strip can tell `unreadable` from `none`", async () => {
    const { fake } = client(() => ({ ok: false, error: { code: "NOT_FOUND", message: "no such workspace" } }));
    expect(await loadTarget(fake, "other")).toEqual({ ok: false, message: "no such workspace", code: "NOT_FOUND" });
  });
});

describe("the web search form", () => {
  it("asks each kind for what it needs, as the owner checks it", () => {
    expect(searchKindNeeds("tavily")).toEqual({ key: "optional", baseUrl: false });
    expect(searchKindNeeds("brave")).toEqual({ key: "required", baseUrl: false });
    expect(searchKindNeeds("searxng")).toEqual({ key: "none", baseUrl: true });
    const base = { kind: "tavily" as const, providerId: "tavily", baseUrl: "", apiKey: "" };
    expect(validateWebSearchForm(base)).toEqual({});
    expect(validateWebSearchForm({ ...base, kind: "brave" })).toEqual({ apiKey: "Brave Search needs an API key" });
    expect(Object.keys(validateWebSearchForm({ ...base, kind: "searxng", baseUrl: "https://user:pw@searx.example" }))).toEqual(["baseUrl"]);
    expect(validateWebSearchForm({ ...base, kind: "searxng", baseUrl: "http://127.0.0.1:8888" })).toEqual({});
    expect(Object.keys(validateWebSearchForm({ ...base, providerId: "Home Search" }))).toEqual(["providerId"]);
    expect(Object.keys(validateWebSearchForm({ ...base, providerId: "p".repeat(65) }))).toEqual(["providerId"]);
    expect(Object.keys(validateWebSearchForm({ ...base, kind: "serper" }))).toEqual(["apiKey"]);
    expect(Object.keys(validateWebSearchForm({ ...base, kind: "brave", apiKey: "   " }))).toEqual(["apiKey"]);
    expect(Object.keys(validateWebSearchForm({ ...base, kind: "brave", apiKey: "k".repeat(16 * 1024 + 1) }))).toEqual(["apiKey"]);
    for (const baseUrl of ["http://searx.example/?q=1", "http://searx.example/#frag", `http://searx.example/${"p".repeat(500)}`]) {
      expect(Object.keys(validateWebSearchForm({ ...base, kind: "searxng", baseUrl })), baseUrl).toEqual(["baseUrl"]);
    }
    expect(freeId("tavily", ["tavily", "tavily-2"])).toBe("tavily-3");
    expect(freeId("brave", ["tavily"])).toBe("brave");
  });

  it("stores a typed key under the provider's own reference, then adds the provider naming it", async () => {
    const { fake, sent } = client(owner({ added: { result: {}, restartRequired: true } }));
    const saved = await saveWebSearchProvider(fake, { kind: "brave", providerId: "brave", baseUrl: "ignored", apiKey: "  bsk-123  " });
    expect(saved).toMatchObject({ ok: true, value: expect.stringContaining("Restart") });
    const writes = sent.filter((request) => request.payload["action"] === "set" || request.payload["action"] === "add");
    expect(writes).toEqual([
      { command: "credentials", payload: { action: "set", reference: "search.brave", value: "bsk-123" } },
      { command: "search", payload: { action: "add", providerId: "brave", kind: "brave", credentialRef: "search.brave" } },
    ]);

    // Keyless: no credential read or written; SearXNG: its instance.
    const keyless = client(owner({ added: { result: {}, restartRequired: false } }));
    expect(
      await saveWebSearchProvider(keyless.fake, { kind: "searxng", providerId: "home", baseUrl: " http://127.0.0.1:8888 ", apiKey: "" }),
    ).toEqual({ ok: true, value: "home added." });
    expect(keyless.sent.filter((request) => request.command !== "search" || request.payload["action"] !== "list")).toEqual([
      { command: "search", payload: { action: "add", providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888" } },
    ]);
  });

  it("never stores a key for a kind that takes none, whatever a hidden field still holds", async () => {
    const { fake, sent } = client(owner({ added: { result: {}, restartRequired: false } }));
    expect(keyToStore({ kind: "searxng", apiKey: "leftover" })).toBe("");
    await saveWebSearchProvider(fake, { kind: "searxng", providerId: "home", baseUrl: "http://127.0.0.1:8888", apiKey: "leftover" });
    expect(sent.map((request) => request.command)).toEqual(["search", "search"]);
    expect(sent.at(-1)?.payload).not.toHaveProperty("credentialRef");
  });

  it("writes no key when the name is taken, or anything already holds search.<id>", async () => {
    // A provider of that name, readable or not — the page's own list may not have it.
    for (const listed of [{ providers: [{ providerId: "brave" }] }, { providers: [], unreadable: ["brave"] }]) {
      const { fake, sent } = client(owner({ providers: listed }));
      expect(await saveWebSearchProvider(fake, { kind: "brave", providerId: "brave", baseUrl: "", apiKey: "k" })).toEqual({
        ok: false,
        message: "A search provider named brave exists: pick another name.",
      });
      expect(sent.map((request) => request.payload["action"])).toEqual(["list"]);
    }
    // A stored credential of that reference, or a model connection naming it.
    for (const holder of [{ credentials: ["search.brave"] }, { connections: [{ credentialRef: "search.brave" }] }]) {
      const { fake, sent } = client(owner(holder));
      expect(await saveWebSearchProvider(fake, { kind: "brave", providerId: "brave", baseUrl: "", apiKey: "k" })).toMatchObject({
        ok: false,
        message: expect.stringContaining("search.brave is already in use"),
      });
      expect(sent.some((request) => request.payload["action"] === "set")).toBe(false);
    }
  });

  it("says which key it stored when the owner then refuses the provider (another writer won the name)", async () => {
    const { fake } = client(owner({ addRefused: "search provider brave already exists" }));
    expect(await saveWebSearchProvider(fake, { kind: "brave", providerId: "brave", baseUrl: "", apiKey: "k" })).toEqual({
      ok: false,
      message: "search provider brave already exists (the key was stored as search.brave; the Credentials view deletes it)",
    });
    const refusedKey = client(owner({ setRefused: "credentials are not writable here" }));
    expect(await saveWebSearchProvider(refusedKey.fake, { kind: "brave", providerId: "brave", baseUrl: "", apiKey: "k" })).toEqual({
      ok: false,
      message: "credentials are not writable here",
      code: "NOT_AUTHORIZED",
    });
    expect(refusedKey.sent.some((request) => request.payload["action"] === "add")).toBe(false);
  });

  it("sends each provider action, and words what it did", async () => {
    const { fake, sent } = client((_command, payload) =>
      payload["action"] === "test"
        ? // What the owner's search test answers: a search's own answer (`sources`), as `tavi search test` prints it.
          { ok: true, result: { sources: [{ url: "https://a.example" }, { url: "https://b.example" }], truncated: false } }
        : { ok: true, result: { result: {}, restartRequired: payload["action"] === "enable" } },
    );
    expect(await searchActions.setEnabled(fake, "home", true)).toEqual({ ok: true, value: expect.stringContaining("Restart") });
    expect(await searchActions.setEnabled(fake, "home", false)).toEqual({ ok: true, value: "home disabled." });
    expect(await searchActions.test(fake, "home")).toEqual({ ok: true, value: "home answered 2 result(s)." });
    expect(await searchActions.remove(fake, { providerId: "brave", credentialRef: "search.brave" })).toEqual({
      ok: true,
      value: "brave removed. Its key search.brave stays stored; the Credentials view deletes it.",
    });
    expect(sent.map((request) => request.payload)).toEqual([
      { action: "enable", providerId: "home" },
      { action: "disable", providerId: "home" },
      { action: "test", providerId: "home" },
      { action: "remove", providerId: "brave" },
    ]);
    // A request that rejects, or a refusal with no words, is still an outcome.
    const broken: SettingsClient = { request: () => Promise.reject(new Error("the connection dropped")) };
    expect(await searchActions.list(broken)).toEqual({ ok: false, message: "the connection dropped" });
    const mute = client(() => ({ ok: false }));
    expect(await searchActions.list(mute.fake)).toEqual({ ok: false, message: "search was refused" });
  });
});

describe("the credentials form", () => {
  it("checks the reference and the value, and sends the value once, trimmed, never reading it back", async () => {
    expect(validateCredentialForm({ reference: "openai.apiKey", value: "sk" })).toEqual({});
    expect(Object.keys(validateCredentialForm({ reference: "OpenAI key", value: "" }))).toEqual(["reference", "value"]);
    expect(Object.keys(validateCredentialForm({ reference: "a", value: "x".repeat(16 * 1024 + 1) }))).toEqual(["value"]);
    // Measured as sent: trimmed.
    expect(validateCredentialForm({ reference: "a", value: ` ${"x".repeat(16 * 1024)} ` })).toEqual({});
    const { fake, sent } = client((_command, payload) =>
      payload["action"] === "list"
        ? { ok: true, result: { credentials: ["openai.apiKey"], unusable: [] } }
        : { ok: true, result: { reference: "openai.apiKey" } },
    );
    expect(await credentialActions.list(fake)).toEqual({ ok: true, value: { credentials: ["openai.apiKey"], unusable: [] } });
    await credentialActions.set(fake, { reference: "openai.apiKey", value: " sk-live \n" });
    await credentialActions.remove(fake, "openai.apiKey");
    expect(sent.slice(1)).toEqual([
      { command: "credentials", payload: { action: "set", reference: "openai.apiKey", value: "sk-live" } },
      { command: "credentials", payload: { action: "delete", reference: "openai.apiKey" } },
    ]);
  });
});

describe("the running owner's target beside the saved choice", () => {
  const answering = (document: unknown) => client(() => ({ ok: true, result: document }));

  it("names what the owner runs, not the saved default, and what a restart would run instead", async () => {
    const { fake } = answering({
      activeTarget: { connectionId: "openai", model: "gpt-4.1-mini" },
      restartTarget: { connectionId: "other", model: "next" },
      restartRequired: true,
      workspaceDefault: { target: { connectionId: "other", model: "next" } },
      resolved: [],
    });
    const loaded = await loadTarget(fake, "default");
    expect(loaded).toEqual({
      ok: true,
      value: { running: "openai/gpt-4.1-mini", unconfigured: false, afterRestart: "other/next", restartRequired: true },
    });
    const target = (loaded as { value: OwnerTarget }).value;
    // The picker shows the choice just made; the notice says it is not yet running.
    expect(chosenTarget(target)).toBe("other/next");
    expect(targetNotice(target)).toBe("The owner runs openai/gpt-4.1-mini until `tavi serve` is restarted; then it runs other/next.");
  });

  it("says nothing while the owner runs what was chosen", async () => {
    const { fake } = answering({
      activeTarget: { connectionId: "openai", model: "gpt-4.1" },
      restartTarget: { connectionId: "openai", model: "gpt-4.1" },
      restartRequired: false,
      workspaceDefault: null,
      resolved: [],
    });
    const target = ((await loadTarget(fake, "default")) as { value: OwnerTarget }).value;
    expect(chosenTarget(target)).toBe("openai/gpt-4.1");
    expect(targetNotice(target)).toBeUndefined();
  });

  it("says an owner on placeholders refuses runs, with or without a model chosen", async () => {
    const chosen = (
      (await loadTarget(
        answering({
          activeTarget: null,
          restartTarget: { connectionId: "openrouter", model: "openai/gpt-4.1" },
          restartRequired: true,
          workspaceDefault: null,
          resolved: [],
        }).fake,
        "default",
      )) as { value: OwnerTarget }
    ).value;
    expect(chosen).toEqual({ running: undefined, unconfigured: true, afterRestart: "openrouter/openai/gpt-4.1", restartRequired: true });
    expect(chosenTarget(chosen)).toBe("openrouter/openai/gpt-4.1");
    expect(targetNotice(chosen)).toContain("Restart `tavi serve` to run openrouter/openai/gpt-4.1.");
    const none = (
      (await loadTarget(
        answering({ activeTarget: null, restartTarget: null, restartRequired: false, workspaceDefault: null, resolved: [] }).fake,
        "default",
      )) as { value: OwnerTarget }
    ).value;
    expect(chosenTarget(none)).toBeUndefined();
    expect(targetNotice(none)).toBe("No model is configured, so runs are refused. Choose a model below.");
  });
});

describe("a chat's own model", () => {
  it("reads the chat's model, and nothing from an owner that predates it", async () => {
    const chosen = await loadChatModel(
      client(() => ({ ok: true, result: { taskId: "t1", target: { connectionId: "openrouter", model: "gpt-4.1" }, source: "chosen" } }))
        .fake,
      "default",
      "t1",
    );
    expect(chosen).toEqual({ ok: true, value: { target: "openrouter/gpt-4.1", source: "chosen" } });
    const gone = await loadChatModel(
      client(() => ({ ok: true, result: { taskId: "t1", target: null, source: "chosen" } })).fake,
      "default",
      "t1",
    );
    expect(gone).toEqual({ ok: true, value: { target: undefined, source: "chosen" } });
    const older = await loadChatModel(
      client(() => ({ ok: false, error: { code: "INVALID_INPUT", message: "unknown action" } })).fake,
      "default",
      "t1",
    );
    expect(older).toEqual({ ok: true, value: undefined });
    const unreadable = await loadChatModel(client(() => ({ ok: true, result: {} })).fake, "default", "t1");
    expect(unreadable.ok).toBe(false);
    const failed = await loadChatModel(
      client(() => ({ ok: false, error: { code: "NOT_FOUND", message: "no task t1" } })).fake,
      "default",
      "t1",
    );
    expect(failed).toMatchObject({ ok: false, message: "no task t1" });
  });

  it("plans a pick by where the composer is, and never leaves an open chat on its old model unsaid", () => {
    expect(planModelPick({ taskId: "t1", newChat: false, support: "supported" })).toEqual({ kind: "chat", taskId: "t1" });
    expect(planModelPick({ taskId: "t1", newChat: false, support: "unsupported" })).toEqual({ kind: "default" });
    expect(planModelPick({ taskId: "t1", newChat: false, support: "unknown" })).toMatchObject({ kind: "wait" });
    expect(planModelPick({ taskId: undefined, newChat: true, support: "unknown" })).toEqual({ kind: "new-chat" });
    // Home, or a chat whose first turn has no task yet: the default only.
    expect(planModelPick({ taskId: undefined, newChat: false, support: "unknown" })).toEqual({ kind: "default" });
  });

  it("says what each pick did, including a default that could not be saved or that something outranks", () => {
    const picked = { connectionId: "or", model: "gpt-4.1" };
    const made = { ok: true as const, value: "gpt-4.1 is the default." };
    const refused = { ok: false as const, message: "store is busy" };
    expect(modelPickNote({ kind: "chat", taskId: "t1" }, picked, made, "or/gpt-4.1")).toEqual({ ok: true, value: undefined });
    expect(modelPickNote({ kind: "chat", taskId: "t1" }, picked, refused, undefined)).toEqual({
      ok: true,
      value: "This chat runs gpt-4.1; it could not be made the default for new chats: store is busy",
    });
    expect(modelPickNote({ kind: "chat", taskId: "t1" }, picked, made, "or/main")).toEqual({
      ok: true,
      value: "This chat runs gpt-4.1; new chats run or/main, which role main or the owner's own flags choose.",
    });
    expect(modelPickNote({ kind: "new-chat" }, picked, made, undefined)).toEqual({ ok: true, value: undefined });
    expect(modelPickNote({ kind: "new-chat" }, picked, refused, undefined)).toEqual({
      ok: true,
      value: "This chat runs gpt-4.1 once its first message is sent; it could not be made the default for new chats: store is busy",
    });
    expect(modelPickNote({ kind: "new-chat" }, picked, made, "or/main")).toEqual({
      ok: true,
      value: "This chat runs gpt-4.1; later new ones run or/main, which role main or the owner's own flags choose.",
    });
    expect(modelPickNote({ kind: "default" }, picked, made, "or/gpt-4.1")).toEqual(made);
    expect(modelPickNote({ kind: "default" }, picked, made, "or/main")).toEqual({
      ok: true,
      value: "gpt-4.1 is the default, but new chats run or/main, which role main or the owner's own flags choose.",
    });
    expect(modelPickNote({ kind: "default" }, picked, refused, undefined)).toEqual(refused);
  });

  it("saves a chat's model with set-chat", async () => {
    const { fake, sent } = client(() => ({ ok: true, result: { result: {}, restartRequired: false } }));
    expect(await modelActions.setChat(fake, "default", "t1", "openrouter", "gpt-4.1")).toEqual({
      ok: true,
      value: "This chat runs gpt-4.1.",
    });
    expect(sent.at(-1)).toEqual({
      command: "models",
      payload: { action: "set-chat", workspaceId: "default", taskId: "t1", connectionId: "openrouter", model: "gpt-4.1" },
    });
  });
});

describe("the system prompt helpers", () => {
  it("separates the saved mode from the text, so an override equal to the default is still an override", () => {
    const builtin = systemPromptState({
      workspaceId: "default",
      revision: 0,
      custom: null,
      shipped: { text: "same", templateVersion: "v1" },
      effective: { text: "same", source: "builtin", revision: null, templateVersion: "v1" },
      appliesTo: "next-message",
      explicitAdapterShadowing: false,
    });
    const override = systemPromptState({
      workspaceId: "default",
      revision: 2,
      custom: {
        text: "same",
        revision: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastOperation: "set",
        previousRevision: 1,
        actor: "operator:cli",
        hash: "a".repeat(64),
      },
      shipped: { text: "same", templateVersion: "v1" },
      effective: { text: "same", source: "workspace", revision: 2, templateVersion: null },
      appliesTo: "next-message",
      explicitAdapterShadowing: false,
    });
    expect(builtin).toMatchObject({ mode: "default", text: "same" });
    expect(override).toMatchObject({ mode: "custom", text: "same" });
    // Identical text, different state — and clearing it is a change.
    expect(systemPromptDirty(override, { mode: "default", text: "same" })).toBe(true);
    expect(systemPromptDirty(builtin, { mode: "default", text: "same" })).toBe(false);
    expect(systemPromptDirty(override, { mode: "custom", text: "same" })).toBe(false);
    expect(systemPromptDirty(override, { mode: "custom", text: "edited" })).toBe(true);
  });

  it("rejects empty, whitespace-only and over-limit drafts, and never judges the shipped text", () => {
    expect(systemPromptProblem("custom", "")).toMatch(/cannot be empty/);
    expect(systemPromptProblem("custom", "   \n")).toMatch(/whitespace only/);
    expect(systemPromptProblem("custom", "x".repeat(20_001))).toMatch(/At most 20,000/);
    expect(systemPromptProblem("custom", "x".repeat(20_000))).toBeUndefined();
    // A `default` draft is a staged reset: its text is the owner's, not the operator's.
    expect(systemPromptProblem("default", "")).toBeUndefined();
  });

  it("sends the write payloads the owner's schema expects, and keeps the refusal code", async () => {
    const { fake, sent } = client((_command, payload) =>
      payload["action"] === "get"
        ? { ok: true, result: { workspaceId: "default", revision: 0, custom: null } }
        : { ok: false, error: { code: "CONFLICT", message: "changed since it was read" } },
    );
    expect((await systemPromptActions.load(fake, "default")).ok).toBe(true);
    const refused = await systemPromptActions.save(fake, "default", "base", 0);
    expect(refused).toEqual({ ok: false, message: "changed since it was read", code: "CONFLICT" });
    await systemPromptActions.reset(fake, "default", 3);
    expect(sent).toEqual([
      { command: "system-prompt", payload: { action: "get", workspaceId: "default" } },
      { command: "system-prompt", payload: { action: "set", workspaceId: "default", text: "base", expectedRevision: 0 } },
      { command: "system-prompt", payload: { action: "reset", workspaceId: "default", expectedRevision: 3 } },
    ]);
  });

  it("leaves a transport failure's code absent rather than inventing one", async () => {
    const failure = client(() => {
      throw new Error("the connection dropped");
    });
    expect(await systemPromptActions.load(failure.fake, "default")).toEqual({ ok: false, message: "the connection dropped" });
  });
});

it("keeps plugin models scoped to their workspace and marks their managed controls", async () => {
  const { fake, sent } = client((_command, payload) => {
    if (payload["action"] === "list")
      return {
        ok: true,
        result: ["home", "work"].map((workspaceId) => ({
          connectionId: `plugin.${workspaceId}`,
          label: workspaceId,
          kind: "openai-compatible",
          baseUrl: "https://example.com",
          credentialRef: "plugins.example.key",
          localOnly: false,
          defaultModel: "m",
          providerBinding: { instanceId: `plugin.${workspaceId}`, workspaceId, principalId: workspaceId, bindingHash: "a".repeat(64) },
        })),
      };
    if (payload["action"] === "roles") return { ok: true, result: { workspaceDefault: null, resolved: [] } };
    return {
      ok: true,
      result: { catalog: [{ connectionId: payload["connectionId"], modelId: "m", state: "available", capabilities: [] }] },
    };
  });
  const result = await loadModels(fake, "home");
  expect(result.ok && result.value.connections.map((item) => item.connectionId)).toEqual(["plugin.home"]);
  expect(result.ok && result.value.models[0]?.providerManaged).toBe(true);
  expect(sent.some((item) => item.payload["connectionId"] === "plugin.work")).toBe(false);
});
