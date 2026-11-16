import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { TaviError, type ChatFolder, type InvocationContext, type SecretReaderPort } from "@tavi/contracts";
import { ToolRegistry, pinnedFetch } from "@tavi/runtime";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { folderSaver, type FsToolOptions } from "../../src/features/folders/fs-tools.js";
import { httpRequestDescription, registerHttpTools } from "../../src/features/http/tools.js";

/**
 * `http.request`'s `saveTo`: the body lands in a new file of the chat's
 * folder, held as `fs.write` holds creating that file — the same
 * confinement, no overwrite, the same subject and ask under taint — and the
 * model gets the file's path, size and sha256 instead of the body.
 */

const directories = temporaryDirectories();
const servers: Server[] = [];

afterEach(async () => {
  directories.cleanup();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  }
});

const noSecrets: SecretReaderPort = { getSecret: async () => null };

async function stub(respond: (path: string) => { status?: number; type?: string; body: Buffer | string }) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    const answer = respond(request.url ?? "/");
    response.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/json" });
    response.end(answer.body);
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${await listenLocally(server)}`, requests };
}

function chat(
  options: Partial<FsToolOptions> & {
    readonly maxResponseBytes?: number;
    readonly secrets?: SecretReaderPort;
    readonly allowedHosts?: readonly string[];
    readonly fetchImpl?: typeof fetch;
  } = {},
  host = false,
) {
  const base = realpathSync(directories.create("tavi-http-save-"));
  const data = join(base, "data");
  const managed = join(data, "chats", "default", "task-a");
  mkdirSync(managed, { recursive: true });
  const project = join(base, "project");
  mkdirSync(project);
  const folder: ChatFolder = {
    primary: host ? project : managed,
    primaryKind: host ? "host" : "managed",
    managed,
    scratch: join(managed, ".tmp"),
    home: join(managed, ".home"),
    attachments: [],
    revision: 1,
  };
  const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "task-a", caller: "test", folder };
  const { maxResponseBytes, secrets, allowedHosts, fetchImpl, ...fsOptions } = options;
  const registry = new ToolRegistry();
  registerHttpTools(registry, {
    secretReader: secrets ?? noSecrets,
    allowedHosts: allowedHosts ?? ["127.0.0.1"],
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    credentialHosts: { "acme.key": ["127.0.0.1"] },
    saver: folderSaver({ dataDirectory: data, ...fsOptions }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
  const tool = registry.get("http.request")!;
  const assess = (input: unknown) => tool.assess!(input, context);
  const call = (input: unknown) =>
    tool.handler({ input, context, signal: new AbortController().signal, assessedSubjects: assess(input).subjects });
  return { base, managed, project, context, assess, call };
}

async function rejection(promise: Promise<unknown>): Promise<TaviError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (error instanceof TaviError) return error;
  throw new Error(`expected a TaviError, received ${String(error)}`);
}

describe("http.request saveTo", () => {
  it("saves the body to a new file of the managed folder and answers with its path, size and sha256", async () => {
    let marked = 0;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const server = await stub(() => ({ type: "image/png", body: png }));
    const { managed, call } = chat({ markFolderTainted: async () => void (marked += 1) });
    const result = (await call({ url: `${server.baseUrl}/logo.png`, saveTo: "assets/logo.png" })) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 200,
      ok: true,
      contentType: "image/png",
      saved: { path: "assets/logo.png", bytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex") },
    });
    expect(result).not.toHaveProperty("body");
    expect(readFileSync(join(managed, "assets", "logo.png"))).toEqual(png);
    // What a remote API answered is untrusted: the chat's folder is marked tainted, as a tainted fs.write marks it.
    expect(marked).toBe(1);
  });

  it("is assessed as fs.write's creation of that file: its subject, its rules, and the request's own sink in the managed folder", () => {
    const { assess } = chat();
    const assessed = assess({ url: "http://127.0.0.1:9/a.json", saveTo: "a.json" });
    expect(assessed.hardDeny).toBeUndefined();
    expect(assessed.subjects[0]).toBe("GET http://127.0.0.1:9/a.json");
    expect(assessed.subjects).toHaveLength(2);
    expect(assessed.subjects[1]).toContain("a.json");
    expect(assessed).toMatchObject({ ruleAliases: ["fs.write"], sink: "network", risk: "medium" });
    expect(assessed.reasons).toContain("creates a file");
    expect(assessed.display.detail).toContain("Save the response to a.json");
  });

  it("is a persist that asks under taint when the file lands in a host folder, and a credential stays a credential", () => {
    const { assess } = chat({}, true);
    expect(assess({ url: "http://127.0.0.1:9/a.json", saveTo: "a.json" })).toMatchObject({ sink: "persist", askWhenTainted: true });
    expect(assess({ url: "http://127.0.0.1:9/a.json", credentialRef: "acme.key", saveTo: "a.json" })).toMatchObject({
      sink: "credential",
      askWhenTainted: true,
    });
  });

  it("refuses a file that exists, and a path outside the chat's folders, before any request is sent", async () => {
    const server = await stub(() => ({ body: "{}" }));
    const { managed, base, assess, call } = chat();
    writeFileSync(join(managed, "taken.json"), "mine");
    expect(assess({ url: `${server.baseUrl}/x`, saveTo: "taken.json" }).hardDeny).toContain("already exists");
    expect((await rejection(call({ url: `${server.baseUrl}/x`, saveTo: "taken.json" }))).message).toContain("already exists");
    expect(readFileSync(join(managed, "taken.json"), "utf8")).toBe("mine");
    const outside = join(base, "elsewhere.json");
    expect(assess({ url: `${server.baseUrl}/x`, saveTo: outside }).hardDeny).toContain("outside your working folder");
    await rejection(call({ url: `${server.baseUrl}/x`, saveTo: outside }));
    expect(existsSync(outside)).toBe(false);
    expect(server.requests).toEqual([]);
  });

  it("saves nothing past the size cap, nor an error page, which comes back as the body", async () => {
    const server = await stub((path) => (path === "/missing" ? { status: 404, body: '{"error":"nope"}' } : { body: "x".repeat(64) }));
    const { managed, call } = chat({ maxResponseBytes: 16 });
    expect((await rejection(call({ url: `${server.baseUrl}/big`, saveTo: "big.json" }))).message).toContain("16-byte limit");
    expect(existsSync(join(managed, "big.json"))).toBe(false);
    const missing = (await call({ url: `${server.baseUrl}/missing`, saveTo: "missing.json" })) as Record<string, unknown>;
    expect(missing).toMatchObject({ status: 404, body: '{"error":"nope"}' });
    expect(missing["note"]).toContain("not saved");
    expect(existsSync(join(managed, "missing.json"))).toBe(false);
  });

  it("refuses to save a body that echoes the credential it was sent with", async () => {
    const server = await stub(() => ({ body: '{"echo":"Bearer sk-live-secret-value"}' }));
    const { managed, call } = chat({ secrets: { getSecret: async () => "sk-live-secret-value" } });
    const refused = await rejection(call({ url: `${server.baseUrl}/echo`, credentialRef: "acme.key", saveTo: "echo.json" }));
    expect(refused.message).toContain("contains the credential");
    expect(refused.message).not.toContain("sk-live");
    expect(existsSync(join(managed, "echo.json"))).toBe(false);
  });

  it("saves nothing from a name that resolves to a private address when it is dialed", async () => {
    const server = await stub(() => ({ body: "{}" }));
    const port = new URL(server.baseUrl).port;
    const { managed, call } = chat({
      allowedHosts: [`api.example.com:${port}`],
      fetchImpl: pinnedFetch({ allowLoopback: true, resolve: async () => ["10.0.0.5"] }),
    });
    const refused = await rejection(call({ url: `https://api.example.com:${port}/a.json`, saveTo: "a.json" }));
    expect(refused.code).toBe("NOT_AUTHORIZED");
    expect(server.requests).toHaveLength(0);
    expect(existsSync(join(managed, "a.json"))).toBe(false);
  });

  it("refuses saveTo where no folder saver is wired", async () => {
    const registry = new ToolRegistry();
    registerHttpTools(registry, { secretReader: noSecrets, allowedHosts: ["127.0.0.1"] });
    const tool = registry.get("http.request")!;
    const context = { workspaceId: "default", principalId: "operator", runId: "task-a", caller: "test" };
    expect(tool.assess!({ url: "http://127.0.0.1:9/a", saveTo: "a.json" }, context).hardDeny).toContain("saveTo is not available");
  });
});

describe("http.request's reach is read once, at registration", () => {
  it("describes and enforces the allowlist it was registered with, whatever later happens to the operator's array", async () => {
    const allowedHosts = ["127.0.0.1"];
    const registry = new ToolRegistry();
    registerHttpTools(registry, { secretReader: noSecrets, allowedHosts });
    allowedHosts.push("evil.example");
    const tool = registry.get("http.request")!;
    expect(tool.description).toBe(httpRequestDescription({ allowedHosts: ["127.0.0.1"] }));
    const context = { workspaceId: "default", principalId: "operator", runId: "task-a", caller: "test" };
    expect(tool.assess!({ url: "https://evil.example/" }, context).hardDeny).toContain("evil.example");
  });
});
