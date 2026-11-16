import { ModelConfigService } from "@tavi/runtime";
import { TaviError, type ModelsPayload } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../support/database-fixture.js";
import { modelsCommand, type ConfigDependencies } from "../../src/server/config-commands.js";

/**
 * An attached client (the page, through the bridge) cannot move a stored key
 * to a new origin: `models add` naming a key no connection uses at that origin
 * is refused when the key is stored — and when the store cannot say whether it is.
 */

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

async function addFromPage(readSecret: ConfigDependencies["readSecret"]) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  closers.push(() => store.close());
  const deps = {
    modelConfig: new ModelConfigService(store.asPort()),
    repositories: store.asPort().repositories,
    startupProviders: [],
    fromBridge: true,
    readSecret,
  } as Partial<ConfigDependencies> as ConfigDependencies;
  return await modelsCommand(deps, {
    action: "add",
    connectionId: "moved",
    baseUrl: "https://elsewhere.example/v1",
    credentialRef: "openai.key",
    defaultModel: "m",
  } as ModelsPayload);
}

describe("a key moved to a new origin from the page", () => {
  it("is refused when the key is stored", async () => {
    expect(await addFromPage(async () => "sk-stored")).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
  });

  it("is refused when the credential store cannot be read, rather than read as no key", async () => {
    const answer = await addFromPage(async () => {
      throw new TaviError("UNAVAILABLE", "Credential reference openai.key is encrypted in a format this build does not read");
    });
    expect(answer).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
  });

  it("is allowed when no such key is stored: there is nothing to send", async () => {
    expect(await addFromPage(async () => null)).toMatchObject({ ok: true });
  });
});
