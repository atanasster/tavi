import { describe, expect, it } from "vitest";

import { createEgressCheck, listedAddresses } from "../../src/features/browser/address-guard.js";

const answers: Readonly<Record<string, readonly string[]>> = {
  "public.example": ["93.184.215.14", "93.184.215.15"],
  "rebind.example": ["10.0.0.5"],
  "mixed.example": ["93.184.215.14", "127.0.0.1"],
  "nas.lan": ["192.168.1.20"],
};

/** A resolver over `answers`; a name not in them does not exist. */
function resolverOf(lookups: string[] = []) {
  return async (hostname: string): Promise<readonly string[]> => {
    lookups.push(hostname);
    const found = answers[hostname];
    if (found === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return found;
  };
}

describe("the address the browser's egress proxy connects to", () => {
  it("is every checked address, never a name to resolve again; a private one only for a host:port the operator listed exactly", async () => {
    const egress = createEgressCheck({
      allowedHosts: ["nas.lan:80", "127.0.0.1:5173", "10.0.0.9", "localhost"],
      resolveHost: resolverOf(),
    });
    expect(await egress("public.example", 443)).toEqual({ addresses: ["93.184.215.14", "93.184.215.15"] });
    expect(await egress("8.8.8.8", 443)).toEqual({ addresses: ["8.8.8.8"] });
    expect(await egress("nas.lan", 80)).toEqual({ addresses: ["192.168.1.20"] });
    expect(await egress("127.0.0.1", 5173)).toEqual({ addresses: ["127.0.0.1"] });
    // A bare entry opens no port of this machine or the private network.
    for (const [host, port] of [
      ["nas.lan", 8080],
      ["127.0.0.1", 5174],
      ["10.0.0.9", 80],
      ["localhost", 3000],
    ] as const) {
      expect(await egress(host, port), `${host}:${String(port)}`).toMatchObject({ refused: expect.any(String) });
    }
    for (const host of [
      "rebind.example",
      "mixed.example",
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "100.64.0.1",
      "localhost",
      "app.localhost",
      "[::1]",
      "[fd00::1]",
      "missing.example",
    ]) {
      expect(await egress(host, 80), host).toMatchObject({ refused: expect.any(String) });
    }
  });

  it("resolves a name once while its answer is fresh", async () => {
    let now = 0;
    const lookups: string[] = [];
    const egress = createEgressCheck({ resolveHost: resolverOf(lookups), now: () => now });
    await egress("public.example", 443);
    await egress("public.example", 443);
    expect(lookups).toEqual(["public.example"]);
    now = 60_000;
    await egress("public.example", 443);
    expect(lookups).toEqual(["public.example", "public.example"]);
  });
});

describe("the browser's address checks under a slow or stalled resolver", () => {
  it("refuses a name it could not check, and asks again next time", async () => {
    const lookups: string[] = [];
    const egress = createEgressCheck({
      now: () => 0,
      resolveHost: async (hostname) => {
        lookups.push(hostname);
        throw new Error(`resolving ${hostname} failed`);
      },
    });
    expect(await egress("slow.example", 443)).toMatchObject({ refused: expect.stringContaining("could not be checked") });
    expect(await egress("slow.example", 443)).toMatchObject({ refused: expect.stringContaining("could not be checked") });
    expect(lookups).toEqual(["slow.example", "slow.example"]);
  });

  it("resolves at most four names at once, queues a few, and refuses past the queue", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const egress = createEgressCheck({
      resolveHost: async () => {
        started += 1;
        await held;
        return ["93.184.215.14"];
      },
    });
    const pending = Array.from({ length: 20 }, (_, index) => egress(`n${index}.example`, 443));
    expect(await egress("overflow.example", 443)).toMatchObject({ refused: expect.stringContaining("could not be checked") });
    expect(started).toBe(4);
    release();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 20 }, () => ({ addresses: ["93.184.215.14"] })));
    expect(started).toBe(20);
  });

  it("refuses at once, for a little while, a name that timed out — that name, not its neighbours", async () => {
    let now = 0;
    const asked: string[] = [];
    const egress = createEgressCheck({
      now: () => now,
      resolveHost: async (hostname) => {
        asked.push(hostname);
        throw Object.assign(new Error(`query ${hostname} timed out`), { code: "ETIMEOUT" });
      },
    });
    expect(await egress("a.slow.example", 443)).toMatchObject({ refused: expect.stringContaining("could not be checked") });
    expect(await egress("a.slow.example", 443)).toMatchObject({ refused: expect.stringContaining("timed out moments ago") });
    await egress("b.slow.example", 443);
    expect(asked).toEqual(["a.slow.example", "b.slow.example"]);
    now = 60_000;
    await egress("a.slow.example", 443);
    expect(asked).toEqual(["a.slow.example", "b.slow.example", "a.slow.example"]);
  });
});

describe("what a confined browser may reach of the private network", () => {
  it("is the addresses among the operator's listed hosts: srt's proxy resolves names there", () => {
    expect(
      listedAddresses(["nas.lan:80", "192.168.1.20", "10.0.0.5:8080", "[fd00::1]:443", "[fd00::2]", "*.corp.example", "127.0.0.1:5173"]),
    ).toEqual(["10.0.0.5:8080", "[fd00::1]:443", "127.0.0.1:5173"]);
  });
});
