import { join } from "node:path";

import { CLIENT_PROTOCOL_VERSION, IPC_PROTOCOL_VERSION, isProtocolMismatch as fromContracts, protocolMismatchError } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { CLIENT_PROTOCOLS, isProtocolMismatch } from "../src/index.js";
import { nodeScheduler, ownerFiles } from "../src/node.js";

describe("@tavi/client entries", () => {
  it("speaks the contracts' protocols, from both entries", async () => {
    expect(CLIENT_PROTOCOLS).toEqual({ ipc: IPC_PROTOCOL_VERSION, events: CLIENT_PROTOCOL_VERSION });
    // `/node` and `/browser` are supersets of the root, sharing one module instance.
    expect((await import("../src/node.js")).CLIENT_PROTOCOLS).toBe(CLIENT_PROTOCOLS);
    expect((await import("../src/browser.js")).CLIENT_PROTOCOLS).toBe(CLIENT_PROTOCOLS);
  });

  it("re-exports the contracts' own mismatch predicate, from both entries", async () => {
    // The same function, so a consumer of either entry recognises the refusal
    // exactly as the owner's own client does.
    expect(isProtocolMismatch).toBe(fromContracts);
    expect((await import("../src/node.js")).isProtocolMismatch).toBe(isProtocolMismatch);
    expect(isProtocolMismatch(protocolMismatchError(IPC_PROTOCOL_VERSION + 1))).toBe(true);
    expect(isProtocolMismatch(new Error("closed before authentication"))).toBe(false);
  });

  it("finds an owner's files where the owner publishes them", () => {
    // The file names are the wire contract between the owner and every client (joined with the platform's separator).
    expect(ownerFiles("/srv/tavi")).toEqual({
      discoveryPath: join("/srv/tavi", "runtime", "ipc.json"),
      tokenPath: join("/srv/tavi", "runtime", "ipc.token"),
    });
  });

  it("schedules on Node's timers, and cancels", async () => {
    const fired: string[] = [];
    const cancel = nodeScheduler.delay(1, () => fired.push("cancelled"));
    cancel();
    let late = (): void => undefined;
    await new Promise<void>((resolve) => {
      late = nodeScheduler.delay(5, () => {
        fired.push("ran");
        resolve();
      });
    });
    // Cancelling after the callback ran is a no-op.
    late();
    expect(fired).toEqual(["ran"]);
  });
});
