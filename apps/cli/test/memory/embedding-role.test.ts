import { TaviError, type ModelEmbedRequest, type ModelPort } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { MEMORY_EMBEDDING_ATTEMPT_PREFIX, REMOTE_EMBEDDING_REFUSED } from "../../src/features/memory/embedding-role.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The `embedding` role in the composed owner:
 * looked up with its locality (the local-or-remote test task summaries use), called through the accounted
 * port, and refused with a typed error when it is unbound, unsuitable, or
 * remote for a local chat's texts.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

/** A fixture transport that embeds each text as [its length, 1] and records what it was sent. */
function fixtureModel(options: { readonly embeds?: boolean } = {}) {
  const sent: ModelEmbedRequest[] = [];
  const model: ModelPort = {
    async stream(request) {
      return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
    },
    ...(options.embeds === false
      ? {}
      : {
          async embed(request: ModelEmbedRequest) {
            sent.push(request);
            return {
              status: "completed" as const,
              attemptId: request.attemptId,
              vectors: request.texts.map((text) => Float32Array.from([text.length, 1])),
              usage: {
                inputTokens: 500,
                inputNoCacheTokens: 500,
                inputCacheReadTokens: 0,
                inputCacheWriteTokens: 0,
                outputTokens: 0,
                totalTokens: 500,
              },
            };
          },
        }),
  };
  return { model, sent };
}

async function owner(model: ModelPort) {
  const dataDirectory = directories.create("tavi-embedding-role-");
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { approvalRequiredFor: [] }), { modelOverride: model });
  runtimes.push(runtime);
  const models = runtime.store.services.modelConfig;
  await models.putConnection({
    connectionId: "cloud",
    label: "cloud",
    baseUrl: "https://api.example.com/v1",
    credentialRef: "cloud.key",
    defaultModel: "chat",
  });
  await models.putConnection({
    connectionId: "ollama",
    label: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    credentialRef: "ollama.key",
    localOnly: true,
  });
  return runtime;
}

const context = { workspaceId: "default", principalId: "operator", runId: "memory-embeddings", caller: "memory" };
const typed = (code: string) => (error: unknown) => error instanceof TaviError && error.code === code;

describe("the embedding role", () => {
  it("is unbound until bound: the workspace default's chat model is never used to embed", async () => {
    const { model, sent } = fixtureModel();
    const runtime = await owner(model);
    await runtime.store.services.modelConfig.setWorkspaceDefault({
      workspaceId: "default",
      target: { connectionId: "cloud", model: "chat" },
    });
    await expect(runtime.embeddings.role("default")).rejects.toSatisfy(typed("NOT_CONFIGURED"));
    await expect(runtime.embeddings.embed({ context, texts: ["hello"], signal: new AbortController().signal })).rejects.toSatisfy(
      typed("NOT_CONFIGURED"),
    );
    expect(sent).toHaveLength(0);
    expect(await runtime.modelAccounting.list(context.runId)).toHaveLength(0);
  });

  it("reports a remote role as remote and a local one as local", async () => {
    const runtime = await owner(fixtureModel().model);
    const models = runtime.store.services.modelConfig;
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    expect(await runtime.embeddings.role("default")).toEqual({
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
      locality: "remote",
    });
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "ollama", model: "nomic-embed-text" },
    });
    expect(await runtime.embeddings.role("default")).toEqual({
      target: { connectionId: "ollama", model: "nomic-embed-text" },
      locality: "local",
    });
  });

  it("round-trips through the fixture transport, recorded with purpose embedding and priced when a sheet exists", async () => {
    const { model, sent } = fixtureModel();
    const runtime = await owner(model);
    await runtime.store.services.modelConfig.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    await runtime.modelAccounting.putPrice({
      revision: "embed-price",
      connectionId: "cloud",
      model: "text-embedding-3-small",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      currency: "USD",
      input: 0.02,
      cacheRead: 0.02,
      cacheWrite: 0.02,
      output: 0,
    });
    const answer = await runtime.embeddings.embed({ context, texts: ["Lisbon flat", "vegetarian"], signal: new AbortController().signal });
    expect(answer.locality).toBe("remote");
    expect(answer.vectors.map((vector) => [...vector])).toEqual([
      [11, 1],
      [10, 1],
    ]);
    expect(sent).toMatchObject([
      { connectionId: "cloud", model: "text-embedding-3-small", runId: context.runId, texts: ["Lisbon flat", "vegetarian"] },
    ]);
    const rows = await runtime.modelAccounting.list(context.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "embedding",
      state: "completed",
      connectionId: "cloud",
      priceRevision: "embed-price",
      operation: { purpose: "embedding", caller: "memory" },
    });
    expect(rows[0]?.estimatedUsd).toBeCloseTo((500 * 0.02) / 1_000_000);
    expect(rows[0]?.request).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("Lisbon");
    // A fixed attempt-id prefix: doctor finds the day's embedding spend in the ledger by it.
    expect(rows[0]?.attemptId.startsWith(MEMORY_EMBEDDING_ATTEMPT_PREFIX)).toBe(true);
    const spend = await runtime.store.memoryEmbeddingSpend({
      since: "2026-01-01T00:00:00.000Z",
      attemptPrefix: MEMORY_EMBEDDING_ATTEMPT_PREFIX,
    });
    expect(spend).toMatchObject({ calls: 1, failed: 0, inputTokens: 500 });
    expect(spend.estimatedUsd).toBeCloseTo((500 * 0.02) / 1_000_000);
    expect(await runtime.store.memoryEmbeddingSpend({ since: "2026-01-01T00:00:00.000Z", attemptPrefix: "memory-review-" })).toMatchObject({
      calls: 0,
    });
  });

  it("refuses a local chat's texts on a remote connection before anything is sent", async () => {
    const { model, sent } = fixtureModel();
    const runtime = await owner(model);
    const models = runtime.store.services.modelConfig;
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    await expect(
      runtime.embeddings.embed({ context, texts: ["my diagnosis"], signal: new AbortController().signal, localOnly: true }),
    ).rejects.toSatisfy(
      (error: unknown) => typed("NOT_AUTHORIZED")(error) && (error as TaviError).details?.["reason"] === REMOTE_EMBEDDING_REFUSED,
    );
    expect(sent).toHaveLength(0);
    expect(await runtime.modelAccounting.list(context.runId)).toHaveLength(0);
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "ollama", model: "nomic-embed-text" },
    });
    expect(
      (await runtime.embeddings.embed({ context, texts: ["my diagnosis"], signal: new AbortController().signal, localOnly: true }))
        .locality,
    ).toBe("local");
    expect(sent).toHaveLength(1);
  });

  it("refuses a local chat's texts when the connection turns remote after its locality was read", async () => {
    const { model, sent } = fixtureModel();
    const runtime = await owner(model);
    const models = runtime.store.services.modelConfig;
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "ollama", model: "nomic-embed-text" },
    });
    const resolveRole = models.resolveRole.bind(models);
    let edited = false;
    models.resolveRole = async (input) => {
      const resolution = await resolveRole(input);
      if (!edited) {
        edited = true;
        await models.putConnection({
          connectionId: "ollama",
          label: "ollama",
          baseUrl: "https://embed.example.com/v1",
          credentialRef: "ollama.key",
          localOnly: false,
        });
      }
      return resolution;
    };
    await expect(
      runtime.embeddings.embed({ context, texts: ["my diagnosis"], signal: new AbortController().signal, localOnly: true }),
    ).rejects.toSatisfy(typed("NOT_AUTHORIZED"));
    expect(edited).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("answers a transport that cannot embed, and a failed call, with typed errors", async () => {
    const runtime = await owner(fixtureModel({ embeds: false }).model);
    await runtime.store.services.modelConfig.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    await expect(runtime.embeddings.embed({ context, texts: ["hello"], signal: new AbortController().signal })).rejects.toSatisfy(
      typed("CAPABILITY_MISSING"),
    );
    const failing: ModelPort = {
      ...fixtureModel().model,
      async embed(request) {
        return {
          status: "failed",
          attemptId: request.attemptId,
          vectors: [],
          usage: {},
          error: { code: "auth", message: "bad key", retryable: false },
        };
      },
    };
    const other = await owner(failing);
    await other.store.services.modelConfig.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    await expect(other.embeddings.embed({ context, texts: ["hello"], signal: new AbortController().signal })).rejects.toSatisfy(
      (error: unknown) => typed("MODEL_FAILED")(error) && (error as TaviError).details?.["modelError"] === "auth",
    );
    expect((await other.modelAccounting.list(context.runId)).map((row) => [row.purpose, row.state])).toEqual([["embedding", "failed"]]);
  });
});
