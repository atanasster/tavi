import { createServer, type AddressInfo, type Server } from "node:net";

/**
 * Loopback ports for a test's servers. Always port 0 on 127.0.0.1: a fixed
 * port (the channel ingress default, 8025, say) may be held by something else
 * on the machine.
 */

/** A port free on 127.0.0.1 a moment ago: the system's pick for port 0, released at once. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listenLocally(probe);
  await closeServer(probe);
  return port;
}

/** Starts `server` on 127.0.0.1 at a port the system picks, and answers that port. */
export async function listenLocally(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | string | null;
  if (address === null || typeof address === "string") throw new Error("the server did not bind a TCP port");
  return address.port;
}

/** Closes `server`, ending its open connections too: a kept-alive client would hold `close` open. */
export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}
