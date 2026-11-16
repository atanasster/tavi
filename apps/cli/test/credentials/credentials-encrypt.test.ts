import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi credentials encrypt`: values
 * encrypted at rest in place, idempotently; still resolved by a run; a
 * backup's copy of `credentials/` useless without the key it does not carry.
 */

const cleanups: (() => Promise<void> | void)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  directories.cleanup();
});

function directory(prefix: string): string {
  return directories.create(prefix);
}

async function tavi(...args: string[]): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const captured = capture();
  const code = await main(args, { io: captured.io });
  return { code, out: captured.stdout(), err: captured.stderr() };
}

/** A model endpoint that remembers the Authorization it was sent, and answers. */
async function model(): Promise<{ readonly url: string; readonly authorizations: (string | undefined)[] }> {
  const authorizations: (string | undefined)[] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      authorizations.push(request.headers.authorization);
      const chunk = (delta: unknown, finish: string | null) => ({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify(chunk({ role: "assistant", content: "ok" }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP port");
  return { url: `http://127.0.0.1:${address.port}/v1`, authorizations };
}

describe("tavi credentials encrypt", () => {
  it("encrypts every value in place, once; a run still resolves them; later values are written encrypted", async () => {
    const data = directory("tavi-encrypt-");
    const store = async (reference: string, value: string) => {
      const file = join(data, `${reference}.source`);
      writeFileSync(file, `${value}\n`, { mode: 0o600 });
      return await tavi("credentials", "set", reference, "--file", file, "--data-dir", data);
    };
    const endpoint = await model();
    expect((await store("model.key", "sk-live-model")).code).toBe(EXIT.ok);
    expect((await store("other.key", "sk-live-other")).code).toBe(EXIT.ok);
    expect(readFileSync(join(data, "credentials", "model.key"), "utf8")).toBe("sk-live-model");

    const first = await tavi("credentials", "encrypt", "--data-dir", data);
    expect(first.code).toBe(EXIT.ok);
    expect(first.out).toContain(`created the key ${join(data, "credentials.key")}; encrypted 2 credentials`);
    expect(first.out).toContain("Keep the key apart from any copy of the credentials");
    expect(statSync(join(data, "credentials.key")).mode & 0o777).toBe(0o600);
    for (const reference of ["model.key", "other.key"]) {
      const onDisk = readFileSync(join(data, "credentials", reference), "utf8");
      expect(onDisk.startsWith("tavi-enc:v1:")).toBe(true);
      expect(onDisk).not.toContain("sk-live");
      expect(statSync(join(data, "credentials", reference)).mode & 0o777).toBe(0o600);
    }
    // No temporary file is left behind by the per-file rewrite.
    expect(readdirSync(join(data, "credentials")).filter((name) => name.includes(".tmp-"))).toEqual([]);

    // Idempotent: the key found, nothing rewritten.
    const key = readFileSync(join(data, "credentials.key"), "utf8");
    const again = await tavi("credentials", "encrypt", "--format", "json", "--data-dir", data);
    expect(JSON.parse(again.out)).toMatchObject({ keyCreated: false, encrypted: [], alreadyEncrypted: ["model.key", "other.key"] });
    const againText = await tavi("credentials", "encrypt", "--data-dir", data);
    expect(againText.out).toContain("encrypted no credential, 2 already encrypted");
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(key);

    // A value set afterwards is written encrypted; list still names every reference.
    expect((await store("late.key", "sk-live-late")).code).toBe(EXIT.ok);
    expect(readFileSync(join(data, "credentials", "late.key"), "utf8")).not.toContain("sk-live-late");
    expect((await tavi("credentials", "list", "--data-dir", data)).out).toContain("late.key");

    // A run resolves an encrypted key through the owner's chain, and sends the clear value.
    expect(
      (
        await tavi(
          "models",
          "add",
          "stub",
          "--base-url",
          endpoint.url,
          "--credential",
          "model.key",
          "--model",
          "m",
          "--local-only",
          "--data-dir",
          data,
        )
      ).code,
    ).toBe(EXIT.ok);
    expect((await tavi("models", "set-default", "--connection", "stub", "--model", "m", "--data-dir", data)).code).toBe(EXIT.ok);
    expect((await tavi("run", "hello", "--data-dir", data)).code).toBe(EXIT.ok);
    expect(endpoint.authorizations).toEqual(["Bearer sk-live-model"]);
  });

  it("takes no reference, and a backup's copy of the credentials does not carry the key", async () => {
    expect((await tavi("credentials", "encrypt", "model.key", "--data-dir", directory("tavi-encrypt-"))).code).toBe(EXIT.usage);

    const data = directory("tavi-encrypt-");
    const file = join(data, "source");
    writeFileSync(file, "sk-live-backup\n", { mode: 0o600 });
    await tavi("credentials", "set", "backup.key", "--file", file, "--data-dir", data);
    await tavi("credentials", "encrypt", "--data-dir", data);
    // A database to snapshot: any command that opens the store makes one.
    await tavi("models", "list", "--data-dir", data);
    const out = join(directory("tavi-snapshot-"), "snapshot");
    expect((await tavi("backup", "--out", out, "--include-credentials", "--data-dir", data)).code).toBe(EXIT.ok);
    expect(readFileSync(join(out, "credentials", "backup.key"), "utf8")).not.toContain("sk-live-backup");
    expect(existsSync(join(out, "credentials.key"))).toBe(false);
  });

  it("clears what an interrupted write left, says what it cannot encrypt or read, and refuses ciphertext as a value", async () => {
    const data = directory("tavi-encrypt-");
    const file = join(data, "source");
    writeFileSync(file, "sk-live-first\n", { mode: 0o600 });
    await tavi("credentials", "set", "first.key", "--file", file, "--data-dir", data);
    const credentials = join(data, "credentials");
    // An interrupted write's temporary, a dotfile and a file that is no reference: each holds plain text.
    writeFileSync(join(credentials, "first.key.tmp-0123456789ab"), "sk-live-orphan", { mode: 0o600 });
    writeFileSync(join(credentials, ".notes"), "sk-live-dotfile", { mode: 0o600 });
    writeFileSync(join(credentials, "Not A Ref"), "sk-live-invalid", { mode: 0o600 });
    // A value another directory's key encrypted.
    const other = directory("tavi-encrypt-other-");
    await tavi("credentials", "set", "foreign.key", "--file", file, "--data-dir", other);
    await tavi("credentials", "encrypt", "--data-dir", other);
    copyFileSync(join(other, "credentials", "foreign.key"), join(credentials, "foreign.key"));

    const run = await tavi("credentials", "encrypt", "--format", "json", "--data-dir", data);
    expect(JSON.parse(run.out)).toMatchObject({
      encrypted: ["first.key"],
      alreadyEncrypted: [],
      undecryptable: ["foreign.key"],
      unencrypted: expect.arrayContaining(["Not A Ref", ".notes"]),
      removedTemporaries: 1,
    });
    expect(existsSync(join(credentials, "first.key.tmp-0123456789ab"))).toBe(false);
    const text = await tavi("credentials", "encrypt", "--data-dir", data);
    expect(text.err).toContain("not readable with this key");
    expect(text.err).toContain("left as they are, not encrypted");

    // An encrypted file given as a value's source is refused: its ciphertext is no value.
    const cipher = join(data, "cipher");
    copyFileSync(join(credentials, "first.key"), cipher);
    const refused = await tavi("credentials", "set", "copy.key", "--file", cipher, "--data-dir", data);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.err).toContain("holds an encrypted credential");
  });

  it("refuses an encrypted file as `models test|discover --credential-file`, sending the provider nothing", async () => {
    const data = directory("tavi-encrypt-");
    const endpoint = await model();
    const file = join(data, "source");
    writeFileSync(file, "sk-live-model\n", { mode: 0o600 });
    await tavi("credentials", "set", "model.key", "--file", file, "--data-dir", data);
    await tavi("credentials", "encrypt", "--data-dir", data);
    expect(
      (
        await tavi(
          "models",
          "add",
          "stub",
          "--base-url",
          endpoint.url,
          "--credential",
          "model.key",
          "--model",
          "m",
          "--local-only",
          "--data-dir",
          data,
        )
      ).code,
    ).toBe(EXIT.ok);
    const cipher = join(data, "credentials", "model.key");
    for (const action of ["test", "discover"]) {
      const refused = await tavi("models", action, "stub", "--credential-file", cipher, "--data-dir", data);
      expect(refused.code, action).not.toBe(EXIT.ok);
      expect(refused.err + refused.out, action).toContain("holds an encrypted credential");
    }
    expect(endpoint.authorizations).toEqual([]);
  });
});

describe("the model's sandbox and the key", () => {
  it("denies the sandbox the key, as it does the credentials themselves", async () => {
    const { composeTaviRuntime } = await import("../../src/runtime/composition.js");
    const { createFixtureSandbox } = await import("@tavi/test-support/sandbox");
    const data = realpathSync(directory("tavi-encrypt-sandbox-"));
    // The chat's own folder, as the workflow stamps it on a turn: the shell runs there.
    const managed = join(data, "chats", "default", "run-1");
    for (const entry of [".tmp", ".home"]) mkdirSync(join(managed, entry), { recursive: true });
    const fixture = createFixtureSandbox({ mode: "echo" });
    const policies: { readonly filesystem?: { readonly denyRead?: readonly string[]; readonly denyWrite?: readonly string[] } }[] = [];
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: data,
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
        providers: [],
        credentials: {},
        defaultConnectionId: "none",
        defaultModel: "none",
        logger: { level: "error", sink: () => undefined },
        scheduleSweepEnabled: false,
      },
      {
        requireModelTransport: false,
        sandboxOverride: {
          ...fixture,
          run: (policy, command) => {
            policies.push(policy);
            return fixture.run(policy, command);
          },
        },
      },
    );
    cleanups.push(async () => void (await runtime.close()));
    await runtime.tools.get("sandbox.run")?.handler({
      input: { command: "cat", args: [join(data, "credentials.key")] },
      context: {
        workspaceId: "default",
        principalId: "operator",
        runId: "run-1",
        caller: "test",
        folder: {
          primary: managed,
          primaryKind: "managed",
          managed,
          scratch: join(managed, ".tmp"),
          home: join(managed, ".home"),
          attachments: [],
          revision: 0,
        },
      },
      signal: new AbortController().signal,
    });
    // Reads: the whole data directory but the chat's own folder; writes: every entry of it by name, the key among them.
    expect(policies[0]?.filesystem?.denyRead).toContain(data);
    expect(policies[0]?.filesystem?.denyWrite).toEqual(expect.arrayContaining([join(data, "credentials"), join(data, "credentials.key")]));
  });
});
