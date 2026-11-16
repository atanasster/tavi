import type { FetchLike } from "@modelcontextprotocol/client";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it, vi } from "vitest";

import { writeMcpPluginDirectory } from "../../src/features/mcp/add.js";

/**
 * A registry remote probed once when it is added: a 401 naming RFC 9728 protected-resource metadata makes it an OAuth
 * server, signed in from its app's page; anything else leaves it as listed.
 */

const directories = temporaryDirectories({ prefix: "tavi-mcp-registry-oauth-" });
afterAll(() => directories.cleanup());

const SERVER = "https://mcp.notes.example/mcp";
const listing = (headers?: readonly unknown[]) => ({
  server: {
    name: "com.example/notes",
    description: "Your notes.",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: SERVER, ...(headers === undefined ? {} : { headers }) }],
  },
});

/** The registry answering one listing, and the server answering the probe with `answer`. */
function registry(answer: () => Response, headers?: readonly unknown[]) {
  const probes: RequestInit[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    if (url.host === "registry.example") return Response.json(listing(headers));
    if (url.href === SERVER) {
      probes.push(init ?? {});
      return answer();
    }
    return new Response("not found", { status: 404 });
  };
  return { placement: { dataDirectory: directories.create(), registry: { fetch, base: "https://registry.example" } }, probes };
}

const add = (placement: ReturnType<typeof registry>["placement"]) =>
  writeMcpPluginDirectory(
    { slug: "notes", form: { kind: "registry", name: "com.example/notes", version: "1.0.0", option: "remote" } },
    placement,
  );

describe("a registry remote's sign-in, found when it is added", () => {
  it("is OAuth when the server's 401 names its protected-resource metadata, and is probed once", async () => {
    const { placement, probes } = registry(
      () =>
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.notes.example/.well-known/oauth-protected-resource"' },
        }),
    );
    const written = await add(placement);
    expect(written.manifest.mcp).toMatchObject({ transport: "http", url: { value: SERVER }, auth: "oauth" });
    // A client of its own is optional: registration (DCR) or a metadata document otherwise.
    expect(written.manifest.config).toMatchObject({ clientId: { required: false }, clientSecret: { type: "credential", required: false } });
    expect(written.notes).toContain("it answered that it signs in with OAuth: connect it once it is reviewed (`tavi apps connect`)");
    expect(probes).toHaveLength(1);
    // The probe carries nothing of the person's: an MCP ping, no credentials.
    expect(new Headers(probes[0]?.headers).get("authorization")).toBeNull();
  });

  it("stays as listed for a 401 without metadata, any other answer, or no answer", async () => {
    for (const answer of [
      () => new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
      () => Response.json({ jsonrpc: "2.0", id: 0, result: {} }),
      (): Response => {
        throw new Error("unreachable");
      },
    ]) {
      const written = await add(registry(answer).placement);
      expect(written.manifest.mcp).toMatchObject({ auth: "none" });
      expect(written.manifest.config["clientId"]).toBeUndefined();
    }
  });

  it("gives up on a server that never answers, at the probe's deadline", async () => {
    const { placement, probes } = registry(() => new Response(null, { status: 401 }));
    const hanging: typeof placement.registry.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.href);
      if (url.href !== SERVER) return await placement.registry.fetch(input, init);
      probes.push(init ?? {});
      // Never answers: only the probe's own signal ends it.
      return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    };
    const signals: AbortSignal[] = [];
    const watched: typeof hanging = async (input, init) => {
      if (init?.signal) signals.push(init.signal);
      return await hanging(input, init);
    };
    const pending = add({ ...placement, registry: { ...placement.registry, fetch: watched } });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // The probe carries a deadline of its own; ending it leaves the server as listed.
    const signal = signals[0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    signal.dispatchEvent(new Event("abort"));
    expect((await pending).manifest.mcp).toMatchObject({ auth: "none" });
  });

  it("does not probe a remote the listing gives its own headers", async () => {
    const { placement, probes } = registry(
      () => new Response(null, { status: 401 }),
      [{ name: "Authorization", value: "Bearer {token}", isSecret: true }],
    );
    const written = await add(placement);
    expect(written.manifest.mcp).toMatchObject({ auth: "headers" });
    expect(probes).toHaveLength(0);
  });
});
