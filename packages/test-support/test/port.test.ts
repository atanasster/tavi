import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { closeServer, freePort, listenLocally } from "../src/port.js";

describe("freePort", () => {
  it("answers a loopback port another server can then take", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    expect(server.address() as AddressInfo).toMatchObject({ address: "127.0.0.1", port });
    await closeServer(server);
  });
});

describe("listenLocally", () => {
  it("binds 127.0.0.1 at a port the system picks, and closeServer ends kept-alive connections", async () => {
    const server = createHttpServer((_request, response) => response.end("ok"));
    const port = await listenLocally(server);
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "keep-alive" } });
    expect(await response.text()).toBe("ok");
    await closeServer(server);
    expect(server.listening).toBe(false);
  });
});
