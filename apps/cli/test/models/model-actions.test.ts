import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";

import { ModelConfigService } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { testAndRecord } from "../../src/features/models/actions.js";

/**
 * `models test`'s generation: it honours the test's own
 * deadline — a provider that accepts and then stalls cannot hold the command, or
 * an owner's request, open — and it offers the probe tool, so a model that can
 * call tools is recorded as able to.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function serviceWith(baseUrl: string): Promise<ModelConfigService> {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  closers.push(async () => store.close());
  const service = new ModelConfigService(store.asPort());
  await service.putConnection({ connectionId: "probe", label: "probe", baseUrl, credentialRef: "probe.key", defaultModel: "m" });
  return service;
}

describe("testAndRecord", () => {
  it("gives up at the test's deadline on an endpoint that accepts and never answers — a failure it does not record against the model", async () => {
    const sockets: Socket[] = [];
    const stalled: TcpServer = createTcpServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve()));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          stalled.close(() => resolve());
        }),
    );
    const address = stalled.address();
    if (address === null || typeof address === "string") throw new Error("did not bind");
    const service = await serviceWith(`http://127.0.0.1:${address.port}/v1`);

    const started = Date.now();
    const result = await testAndRecord(service, "probe", undefined, async () => "sk-probe", 300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, transient: true, message: expect.stringContaining("exceeded 300ms") });
    // A stall says nothing lasting of the model: recorded unavailable, every run would skip it.
    expect(await service.listCatalog("probe")).toEqual([]);
  });

  it("records a model unavailable on a lasting refusal — its key — but not on a rate limit", async () => {
    let status = 429;
    const endpoint: HttpServer = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: status === 429 ? "slow down" : "bad key", type: status === 429 ? "rate_limit" : "invalid_api_key" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => endpoint.close(() => resolve())));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("did not bind");
    const service = await serviceWith(`http://127.0.0.1:${address.port}/v1`);

    const limited = await testAndRecord(service, "probe", undefined, async () => "sk-probe");
    expect(limited).toMatchObject({ ok: false, transient: true });
    expect(await service.listCatalog("probe")).toEqual([]);

    status = 401;
    const refused = await testAndRecord(service, "probe", undefined, async () => "sk-probe");
    expect(refused.ok).toBe(false);
    expect(refused.transient).toBeUndefined();
    expect(await service.listCatalog("probe")).toEqual([expect.objectContaining({ modelId: "m", state: "unavailable" })]);
  });

  it("offers the probe tool, so a tool-calling model can be recorded as one", async () => {
    const bodies: string[] = [];
    const endpoint: HttpServer = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => endpoint.close(() => resolve())));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("did not bind");

    const result = await testAndRecord(
      await serviceWith(`http://127.0.0.1:${address.port}/v1`),
      "probe",
      undefined,
      async () => "sk-probe",
    );
    expect(result.ok).toBe(true);
    expect(bodies.some((body) => body.includes("probe_noop"))).toBe(true);
  });
});
