import { ModelConfigService } from "@tavi/runtime";
import { join } from "node:path";

import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { searchCommand, type ConfigDependencies } from "../../src/server/config-commands.js";

/**
 * The owner's `search` handler, on a real store: the answers a page
 * and `tavi search` read, and that no write needs a restart.
 */

const directories = temporaryDirectories({ prefix: "tavi-search-ipc-" });
const cleanups: (() => void)[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  directories.cleanup();
});

async function deps(
  fetch?: typeof globalThis.fetch,
  launched: Pick<ConfigDependencies, "startupProviders" | "launcherBindings"> = { startupProviders: [] },
): Promise<ConfigDependencies> {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  cleanups.push(() => store.close());
  stores.push(store);
  return {
    repositories: store.asPort().repositories,
    modelConfig: new ModelConfigService(store.asPort()),
    dataDirectory: directory,
    target: { source: "default", connectionId: "c", model: "m", workspaceId: "default" },
    videoStatus: () => Promise.resolve({}),
    ...launched,
    readSecret: (reference) => Promise.resolve(reference === "serper.apiKey" ? "sk-serper" : null),
    ...(fetch === undefined ? {} : { searchFetch: fetch }),
    now: () => new Date("2026-09-19T12:00:00.000Z"),
  };
}

describe("the search handler", () => {
  it("takes a key only under a search reference, never one a launched connection or the launcher holds, checked again at test", async () => {
    const fetch: typeof globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ organic: [] }), { status: 200 }));
    const owner = await deps(fetch, {
      startupProviders: [{ baseUrl: "https://api.openai.com/v1", credentialRef: "search.launched" }],
      launcherBindings: ["search.bot", "telegram.botToken"],
    });
    const refused = async (credentialRef: string, contains: string) =>
      expect(await searchCommand(owner, { action: "add", providerId: "p", kind: "serper", credentialRef }), credentialRef).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT", message: expect.stringContaining(contains) },
      });
    // Not a search reference: a model's key, a bot's token, another kind's — whatever holds it now or later.
    await refused("openai.apiKey", "must be stored under search.<name> or serper.<name>");
    await refused("telegram.botToken", "must be stored under search.<name>");
    await refused("brave.apiKey", "must be stored under search.<name> or serper.<name>");
    // A search reference that a connection the owner was launched with, or its launcher, holds.
    await refused("search.launched", "a model connection's key");
    await refused("search.bot", "bound by the owner's launcher");
    expect(await searchCommand(owner, { action: "add", providerId: "p", kind: "serper", credentialRef: "serper.apiKey" })).toMatchObject({
      ok: true,
    });

    // Connections change after an add: a connection that takes the provider's reference later stops its test.
    await stores.at(-1)?.asPort().repositories.modelConfig.upsertConnection({
      connectionId: "later",
      label: "Later",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "serper.apiKey",
      localOnly: false,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
    });
    expect(await searchCommand(owner, { action: "test", providerId: "p" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("a model connection's key") },
    });
  });

  it("never asks for a restart: the owner activates an added or enabled provider on demand", async () => {
    const notOffered = await deps();
    expect(await searchCommand(notOffered, { action: "add", providerId: "free", kind: "tavily" })).toMatchObject({
      ok: true,
      result: { result: { providerId: "free", kind: "tavily", enabled: true }, restartRequired: false },
    });
    expect(await searchCommand(notOffered, { action: "disable", providerId: "free" })).toMatchObject({
      ok: true,
      result: { restartRequired: false },
    });
    expect(await searchCommand(notOffered, { action: "enable", providerId: "free" })).toMatchObject({
      ok: true,
      result: { restartRequired: false },
    });

    const offered = await deps();
    expect(await searchCommand(offered, { action: "add", providerId: "free", kind: "tavily" })).toMatchObject({
      ok: true,
      result: { restartRequired: false },
    });
    expect(await searchCommand(offered, { action: "list" })).toMatchObject({ ok: true, result: { providers: [{ providerId: "free" }] } });
    expect(await searchCommand(offered, { action: "remove", providerId: "free" })).toEqual({
      ok: true,
      result: { result: { removed: "free" }, restartRequired: false },
    });
  });

  it("refuses what cannot work, names what does not exist, and tests with the owner's credential chain", async () => {
    const authorizations: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("x-api-key"));
      return Promise.resolve(
        new Response(JSON.stringify({ organic: [{ title: "Tavi", link: "https://tavi.example/", snippet: "s" }] }), { status: 200 }),
      );
    };
    const owner = await deps(fetch);
    expect(await searchCommand(owner, { action: "add", providerId: "brave", kind: "brave" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await searchCommand(owner, { action: "add", providerId: "nokind" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await searchCommand(owner, { action: "enable" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await searchCommand(owner, { action: "remove", providerId: "nobody" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await searchCommand(owner, { action: "test", providerId: "nobody" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    await searchCommand(owner, { action: "add", providerId: "serper", kind: "serper", credentialRef: "serper.apiKey" });
    expect(await searchCommand(owner, { action: "test", providerId: "serper", query: "tavi" })).toMatchObject({
      ok: true,
      result: { truncated: false, sources: [{ title: "Tavi", url: "https://tavi.example/" }] },
    });
    expect(authorizations).toEqual(["sk-serper"]);
  });

  it("refuses a provider naming a model connection's key, bounds the list, and reports a row it cannot read", async () => {
    const owner = await deps();
    const store = stores.at(-1);
    await store?.asPort().repositories.modelConfig.upsertConnection({
      connectionId: "main",
      label: "Main",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "search.shared",
      localOnly: false,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
    });
    // A page could otherwise have the model's key sent to a search provider's endpoint.
    expect(await searchCommand(owner, { action: "add", providerId: "brave", kind: "brave", credentialRef: "search.shared" })).toMatchObject(
      {
        ok: false,
        error: { code: "INVALID_INPUT", message: expect.stringContaining("a model connection's key") },
      },
    );
    expect(await searchCommand(owner, { action: "add", providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" })).toMatchObject({
      ok: true,
    });

    const now = "2026-09-19T12:00:00.000Z";
    store?.handle
      .prepare("INSERT INTO tavi_search_providers (provider_id, kind, enabled, created_at, updated_at) VALUES ('broken', 'brave', 1, ?, ?)")
      .run(now, now);
    for (let index = 0; index < 110; index += 1) {
      await store?.asPort().repositories.searchProviders.add({ providerId: `p${index}`, kind: "tavily", enabled: true, now });
    }
    const listed = await searchCommand(owner, { action: "list" });
    expect(listed).toMatchObject({ ok: true, result: { truncated: true, unreadable: ["broken"] } });
    expect((listed.ok ? (listed.result as { providers: unknown[] }).providers : []).length).toBe(100);
  });
});
