import { join } from "node:path";

import { ModelConfigService } from "@tavi/runtime";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";
import { sse, textChunk } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { probePdf, probePdfAndRecord } from "../../src/features/models/actions.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * `tavi models probe --pdf`: a one-page
 * PDF holding a random code goes to the model as a file; only a model that
 * quotes the code back turns the connection's PDF input on.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function service(baseUrl: string): Promise<ModelConfigService> {
  const directory = directories.create("tavi-pdf-probe-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const models = new ModelConfigService(store.asPort());
  await models.putConnection({ connectionId: "box", label: "Box", baseUrl, credentialRef: "box.key", defaultModel: "local-model" });
  return models;
}

const streamed = (text: string): Response =>
  new Response(sse([textChunk(text, null), textChunk("", "stop")]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** An endpoint that reads the PDF it is sent, and answers with the code it holds; or one that drops files. */
function endpoint(reads: boolean): typeof fetch {
  return fakeFetch(async (_input, init) => {
    const body = String(init?.body ?? "");
    const encoded = /"file_data":"data:application\/pdf;base64,([^"]+)"/.exec(body)?.[1];
    const code =
      reads && encoded !== undefined ? /Probe code: ([A-Z0-9]+)/.exec(Buffer.from(encoded, "base64").toString("latin1"))?.[1] : undefined;
    return streamed(code === undefined ? "I see no document." : `The code is ${code}.`);
  });
}

describe("the PDF probe", () => {
  it("writes a PDF that holds its code and nothing else", () => {
    const text = Buffer.from(probePdf("ABCD2345")).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(Probe code: ABCD2345) Tj");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("turns PDF input on when the model quotes the code back", async () => {
    const models = await service("http://127.0.0.1:9/v1");
    const result = await probePdfAndRecord(models, "box", undefined, async () => "key", { fetch: endpoint(true) });
    expect(result).toMatchObject({ connectionId: "box", modelId: "local-model", ok: true, pdfInput: "openai-file" });
    expect((await models.getConnection("box")).pdfInput).toBe("openai-file");
  });

  it("fails on an endpoint that ignores the file, and leaves PDF input as it was", async () => {
    const models = await service("http://127.0.0.1:9/v1");
    const result = await probePdfAndRecord(models, "box", undefined, async () => "key", { fetch: endpoint(false) });
    expect(result).toMatchObject({ ok: false, pdfInput: "none", message: expect.stringContaining("did not quote the code") });
    expect((await models.getConnection("box")).pdfInput).toBe("none");
  });

  it("says a probe past its deadline timed out, and a provider's error as a failure, turning nothing on", async () => {
    const models = await service("http://127.0.0.1:9/v1");
    const stalled = fakeFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    expect(await probePdfAndRecord(models, "box", undefined, async () => "key", { fetch: stalled, timeoutMs: 200 })).toMatchObject({
      ok: false,
      pdfInput: "none",
      message: "the probe exceeded 200ms",
    });
    const refused = fakeFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const failed = await probePdfAndRecord(models, "box", undefined, async () => "key", { fetch: refused });
    expect(failed.ok).toBe(false);
    expect(failed.message).toBeDefined();
    expect((await models.getConnection("box")).pdfInput).toBe("none");
  });

  it("confirms nothing for a connection edited while it was probed", async () => {
    const models = await service("http://127.0.0.1:9/v1");
    const editing = fakeFetch(async (input, init) => {
      await models.putConnection({
        connectionId: "box",
        label: "Box",
        baseUrl: "http://127.0.0.1:10/v1",
        credentialRef: "box.key",
        defaultModel: "local-model",
      });
      return endpoint(true)(input as string, init);
    });
    await expect(probePdfAndRecord(models, "box", undefined, async () => "key", { fetch: editing })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await models.getConnection("box")).pdfInput).toBe("none");
  });

  it("is named: models probe without --pdf is a usage error", async () => {
    const io = { stdout: () => undefined, stderr: () => undefined, isTty: false };
    expect(await main(["models", "probe", "box"], { io })).toBe(EXIT.usage);
    expect(await main(["models", "test", "box", "--pdf"], { io })).toBe(EXIT.usage);
  });

  it("is refused before anything is sent to an endpoint that drops files", async () => {
    const models = await service("https://api.anthropic.com/v1");
    let sent = false;
    await expect(
      probePdfAndRecord(models, "box", undefined, async () => "key", {
        fetch: fakeFetch(async () => ((sent = true), streamed(""))),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(sent).toBe(false);
  });
});
