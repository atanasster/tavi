import { join } from "node:path";

import { videoDisclosure } from "@tavi/contracts";
import { ModelConfigService } from "@tavi/runtime";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";
import { sse, textChunk } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { discoverAndRecord, setVideoModelAndReport, testAndRecord } from "../../src/features/models/actions.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `tavi models video`: native video on per model, only after its disclosure. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function open(): Promise<{ readonly directory: string; readonly models: ModelConfigService; readonly close: () => void }> {
  const directory = directories.create("tavi-video-models-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const models = new ModelConfigService(store.asPort());
  await models.putConnection({
    connectionId: "router",
    label: "My router",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "router.key",
  });
  await models.putCatalogEntry({
    connectionId: "router",
    modelId: "qwen/qwen3-vl",
    provenance: "live",
    state: "available",
    capabilities: ["video"],
  });
  return { directory, models, close: () => store.close() };
}

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text), isTty: false },
    out: () => out.join(""),
    err: () => err.join(""),
  };
};

describe("tavi models video", () => {
  it("prints the disclosure and turns nothing on without --yes, then turns it on with it, and off again", async () => {
    const { models } = await open();
    const disclosure = videoDisclosure("OpenRouter", "qwen/qwen3-vl");
    await expect(setVideoModelAndReport(models, "router", { enable: "qwen/qwen3-vl", confirmed: false })).rejects.toThrow(disclosure);
    expect((await models.getConnection("router")).videoModels).toBeUndefined();
    expect(await setVideoModelAndReport(models, "router", { enable: "qwen/qwen3-vl", confirmed: true })).toEqual({
      connectionId: "router",
      videoModels: ["qwen/qwen3-vl"],
      disclosure,
    });
    expect(await setVideoModelAndReport(models, "router", { disable: "qwen/qwen3-vl", confirmed: false })).toEqual({
      connectionId: "router",
      videoModels: [],
    });
    await expect(setVideoModelAndReport(models, "router", { enable: "plain", confirmed: true })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("runs from the command line, one of --enable or --disable, the disclosure on stderr without --yes", async () => {
    const { directory, close } = await open();
    close();
    const refused = capture();
    expect(await main(["models", "video", "router", "--enable", "qwen/qwen3-vl", "--data-dir", directory], { io: refused.io })).not.toBe(
      EXIT.ok,
    );
    expect(refused.err()).toContain("sends the whole clip");
    const enabled = capture();
    expect(
      await main(["models", "video", "router", "--enable", "qwen/qwen3-vl", "--yes", "--data-dir", directory], { io: enabled.io }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(enabled.out())).toMatchObject({ videoModels: ["qwen/qwen3-vl"] });
    const usage = capture();
    expect(await main(["models", "video", "router", "--data-dir", directory], { io: usage.io })).toBe(EXIT.usage);
    expect(await main(["models", "video", "router", "--enable", "a", "--disable", "b", "--data-dir", directory], { io: usage.io })).toBe(
      EXIT.usage,
    );
  });
});

describe("the video tokens as discovery and a test write them", () => {
  const listing = (video: boolean): typeof fetch =>
    fakeFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "qwen/qwen3-vl",
                name: "Qwen3 VL",
                context_length: 32_000,
                architecture: { input_modalities: video ? ["text", "video"] : ["text"] },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  const answers: typeof fetch = async () =>
    new Response(sse([textChunk("ok", "stop")]), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("sets and clears the catalog's video token, keeps a probe's, and a test keeps both and the listing's facts", async () => {
    const { models } = await open();
    await discoverAndRecord(models, "router", async () => "key", { fetch: listing(true) });
    const row = async () => (await models.listCatalog("router")).find((entry) => entry.modelId === "qwen/qwen3-vl");
    expect((await row())?.capabilities).toContain("video");
    // A probe's token, then a catalog that drops video: the probe's stays.
    await models.putCatalogEntry({
      connectionId: "router",
      modelId: "qwen/qwen3-vl",
      provenance: "live",
      state: "available",
      displayName: "Qwen3 VL",
      contextWindow: 32_000,
      capabilities: [...((await row())?.capabilities ?? []), "video-probed"],
    });
    await discoverAndRecord(models, "router", async () => "key", { fetch: listing(false) });
    expect((await row())?.capabilities).toEqual(["video-probed"]);
    await testAndRecord(models, "router", "qwen/qwen3-vl", async () => "key", 5_000, { fetch: answers });
    expect(await row()).toMatchObject({
      displayName: "Qwen3 VL",
      contextWindow: 32_000,
      capabilities: expect.arrayContaining(["video-probed", "chat"]),
    });
  });

  it("asks for the disclosure only once the model can have video at all", async () => {
    const { models } = await open();
    await models.putConnection({
      connectionId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      credentialRef: "openai.key",
    });
    await expect(setVideoModelAndReport(models, "openai", { enable: "gpt-x", confirmed: false })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(setVideoModelAndReport(models, "router", { enable: "unlisted", confirmed: false })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
